package com.scrcpyjev;

import android.app.UiAutomation;
import android.graphics.Rect;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.os.HandlerThread;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.EOFException;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * A long-lived on-device UI server for scrcpy-jev.
 *
 * <p>Running {@code uiautomator dump} costs ~2.7 s per call because every invocation boots a fresh
 * JVM and reconnects the accessibility bridge. This process connects once and then answers dump
 * requests over a local abstract socket, which brings an observation down to a few dozen
 * milliseconds.
 *
 * <p>Wire format: 4-byte big-endian length prefix + UTF-8 JSON, in both directions.
 */
public final class JevServer {
  private static final String SOCKET_NAME = "scrcpy_jev";
  private static final int MAX_REQUEST = 1 << 20;
  private static final int MAX_NODES = 40_000;
  /**
   * The helper is shared by whichever clients connect to its socket, so it must not be killed by
   * one client while another is using it. Instead it retires itself once nobody has asked for
   * anything for a long while, which keeps the device clean without cross-process kills.
   */
  private static final long IDLE_TIMEOUT_MS = 30 * 60 * 1000L;
  private static volatile long lastRequestAt = System.currentTimeMillis();

  private final UiAutomation automation;
  private final HandlerThread thread;
  private final String build;

  private JevServer(String build) throws Exception {
    this.build = build;
    thread = new HandlerThread("scrcpy-jev");
    thread.start();
    automation = connect(thread.getLooper());
  }

  /**
   * Builds the same {@link UiAutomation} a shell-driven instrumentation would: a direct connection
   * owned by this process instead of a bound accessibility service. Both the constructor and
   * {@code connect()} are hidden from the public SDK, so they are reached by reflection exactly as
   * the platform's own {@code uiautomator} command does.
   */
  private static UiAutomation connect(android.os.Looper looper) throws Exception {
    Class<?> connectionType = Class.forName("android.app.UiAutomationConnection");
    Object connection = connectionType.getConstructor().newInstance();
    Class<?> connectionInterface = Class.forName("android.app.IUiAutomationConnection");
    Constructor<UiAutomation> constructor =
        UiAutomation.class.getDeclaredConstructor(android.os.Looper.class, connectionInterface);
    constructor.setAccessible(true);
    UiAutomation automation = constructor.newInstance(looper, connection);
    Method connect = UiAutomation.class.getDeclaredMethod("connect");
    connect.setAccessible(true);
    connect.invoke(automation);
    return automation;
  }

  public static void main(String[] args) throws Exception {
    JevServer server = new JevServer(args.length > 0 ? args[0] : "unknown");
    LocalServerSocket listener = new LocalServerSocket(SOCKET_NAME);
    startIdleWatchdog();
    System.out.println("scrcpy-jev helper ready");
    while (true) {
      LocalSocket socket = listener.accept();
      try {
        server.serve(socket);
      } catch (Exception error) {
        System.err.println("session failed: " + error);
      } finally {
        try {
          socket.close();
        } catch (Exception ignored) {
          // The peer is already gone.
        }
      }
    }
  }

  private static void startIdleWatchdog() {
    Thread watchdog =
        new Thread(
            () -> {
              while (true) {
                try {
                  Thread.sleep(60_000L);
                } catch (InterruptedException interrupted) {
                  return;
                }
                if (System.currentTimeMillis() - lastRequestAt > IDLE_TIMEOUT_MS) {
                  System.exit(0);
                }
              }
            },
            "scrcpy-jev-idle");
    watchdog.setDaemon(true);
    watchdog.start();
  }

  private void serve(LocalSocket socket) throws Exception {
    DataInputStream input = new DataInputStream(socket.getInputStream());
    DataOutputStream output = new DataOutputStream(socket.getOutputStream());
    while (true) {
      int length;
      try {
        length = input.readInt();
      } catch (EOFException end) {
        return;
      }
      if (length <= 0 || length > MAX_REQUEST) return;
      byte[] payload = new byte[length];
      input.readFully(payload);
      lastRequestAt = System.currentTimeMillis();
      String request = new String(payload, StandardCharsets.UTF_8);
      String command = field(request, "cmd");
      String reply;
      if ("dump".equals(command)) {
        reply = dump();
      } else if ("ping".equals(command)) {
        reply = "{\"ok\":true,\"pong\":true,\"build\":" + quote(build) + "}";
      } else if ("quit".equals(command)) {
        writeFrame(output, "{\"ok\":true}");
        return;
      } else {
        reply = "{\"ok\":false,\"error\":\"unknown command\"}";
      }
      writeFrame(output, reply);
    }
  }

  private static void writeFrame(DataOutputStream output, String text) throws Exception {
    byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
    output.writeInt(bytes.length);
    output.write(bytes);
    output.flush();
  }

  /** A deliberately tiny reader for the flat request objects this server accepts. */
  private static String field(String json, String name) {
    int at = json.indexOf('"' + name + '"');
    if (at < 0) return null;
    int colon = json.indexOf(':', at);
    if (colon < 0) return null;
    int start = json.indexOf('"', colon);
    if (start < 0) return null;
    int end = json.indexOf('"', start + 1);
    if (end < 0) return null;
    return json.substring(start + 1, end);
  }

  private String dump() {
    StringBuilder out = new StringBuilder(1 << 16);
    List<AccessibilityNodeInfo> roots = new ArrayList<>();
    List<String> rootPaths = new ArrayList<>();
    try {
      List<AccessibilityWindowInfo> windows = automation.getWindows();
      if (windows != null) {
        for (int i = 0; i < windows.size(); i++) {
          AccessibilityNodeInfo root = windows.get(i).getRoot();
          if (root != null) {
            roots.add(root);
            rootPaths.add("w" + i);
          }
        }
      }
      if (roots.isEmpty()) {
        AccessibilityNodeInfo active = automation.getRootInActiveWindow();
        if (active != null) {
          roots.add(active);
          rootPaths.add("w0");
        }
      }
    } catch (RuntimeException error) {
      return "{\"ok\":false,\"error\":\"accessibility bridge unavailable\"}";
    }

    int[] size = displaySize();
    int width = size == null ? 0 : size[0];
    int height = size == null ? 0 : size[1];
    int rotation = size == null ? 0 : size[2];
    String packageName = "";
    boolean editable = false;
    boolean focusedEditable = false;
    boolean keyboard = false;

    StringBuilder nodes = new StringBuilder(1 << 18);
    int count = 0;
    for (int i = 0; i < roots.size(); i++) {
      count = visit(roots.get(i), rootPaths.get(i), 0, nodes, count);
    }
    for (AccessibilityNodeInfo root : roots) {
      if (packageName.isEmpty() && root.getPackageName() != null) {
        packageName = root.getPackageName().toString();
      }
    }
    // The IME is a window owned by an input-method package; its presence is our keyboard signal.
    for (int i = 0; i < roots.size(); i++) {
      CharSequence pkg = roots.get(i).getPackageName();
      if (pkg == null) continue;
      String name = pkg.toString();
      if (name.contains("inputmethod") || name.contains("keyboard") || name.contains("ime")) {
        keyboard = true;
        if (packageName.contains("inputmethod")) packageName = previousApp(roots, i);
      }
    }
    int[] flags = editableFlags(roots);
    editable = flags[0] == 1;
    focusedEditable = flags[1] == 1;

    out.append("{\"ok\":true");
    out.append(",\"screen\":{\"width\":").append(width).append(",\"height\":").append(height)
        .append(",\"rotation\":").append(rotation).append('}');
    out.append(",\"packageName\":").append(quote(packageName));
    out.append(",\"isEditable\":").append(editable);
    out.append(",\"focusedEditable\":").append(focusedEditable);
    out.append(",\"keyboardVisible\":").append(keyboard);
    out.append(",\"windowCount\":").append(roots.size());
    out.append(",\"nodes\":[").append(nodes).append("]}");
    for (AccessibilityNodeInfo root : roots) {
      try {
        root.recycle();
      } catch (RuntimeException ignored) {
        // Older platforms recycle implicitly.
      }
    }
    return out.toString();
  }

  private static String previousApp(List<AccessibilityNodeInfo> roots, int skip) {
    for (int i = 0; i < roots.size(); i++) {
      if (i == skip) continue;
      CharSequence pkg = roots.get(i).getPackageName();
      if (pkg != null) return pkg.toString();
    }
    return "";
  }

  private static int[] editableFlags(List<AccessibilityNodeInfo> roots) {
    int editable = 0;
    int focused = 0;
    for (AccessibilityNodeInfo root : roots) {
      int[] found = scanEditable(root);
      editable += found[0];
      focused += found[1];
    }
    return new int[] {editable > 0 ? 1 : 0, focused > 0 ? 1 : 0};
  }

  private static int[] scanEditable(AccessibilityNodeInfo node) {
    int editable = 0;
    int focused = 0;
    try {
      if (node.isEditable() && node.isEnabled()) {
        editable++;
        if (node.isFocused()) focused++;
      }
      for (int i = 0; i < node.getChildCount(); i++) {
        AccessibilityNodeInfo child = node.getChild(i);
        if (child == null) continue;
        int[] found = scanEditable(child);
        editable += found[0];
        focused += found[1];
        child.recycle();
      }
    } catch (RuntimeException ignored) {
      // A stale node can disappear mid-traversal; the dump simply skips it.
    }
    return new int[] {editable, focused};
  }

  private static int visit(
      AccessibilityNodeInfo node, String path, int depth, StringBuilder out, int count) {
    if (node == null || count >= MAX_NODES) return count;
    Rect bounds = new Rect();
    node.getBoundsInScreen(bounds);
    boolean visible = node.isVisibleToUser();
    CharSequence text = node.getText();
    CharSequence description = node.getContentDescription();
    CharSequence hint = node.getHintText();
    CharSequence resource = node.getViewIdResourceName();
    CharSequence pkg = node.getPackageName();
    CharSequence className = node.getClassName();

    if (count > 0) out.append(',');
    out.append("{\"path\":").append(quote(path));
    out.append(",\"depth\":").append(depth);
    out.append(",\"text\":").append(quote(text == null ? "" : text.toString()));
    out.append(",\"label\":").append(quote(description == null ? "" : description.toString()));
    out.append(",\"hint\":").append(quote(hint == null ? "" : hint.toString()));
    out.append(",\"resourceId\":").append(quote(resource == null ? "" : resource.toString()));
    out.append(",\"package\":").append(quote(pkg == null ? "" : pkg.toString()));
    out.append(",\"className\":").append(quote(className == null ? "" : className.toString()));
    out.append(",\"bounds\":[")
        .append(bounds.left)
        .append(',')
        .append(bounds.top)
        .append(',')
        .append(bounds.right)
        .append(',')
        .append(bounds.bottom)
        .append(']');
    out.append(",\"clickable\":").append(node.isClickable());
    out.append(",\"longClickable\":").append(node.isLongClickable());
    out.append(",\"editable\":").append(node.isEditable());
    out.append(",\"scrollable\":").append(node.isScrollable());
    out.append(",\"enabled\":").append(node.isEnabled());
    out.append(",\"focusable\":").append(node.isFocusable());
    out.append(",\"focused\":").append(node.isFocused());
    out.append(",\"visible\":").append(visible);
    out.append(",\"password\":").append(node.isPassword());
    out.append(",\"checkable\":").append(node.isCheckable());
    out.append(",\"checked\":").append(node.isChecked());
    out.append(",\"selected\":").append(node.isSelected());
    out.append(",\"childCount\":").append(node.getChildCount());
    out.append('}');
    count++;

    for (int i = 0; i < node.getChildCount(); i++) {
      AccessibilityNodeInfo child;
      try {
        child = node.getChild(i);
      } catch (RuntimeException error) {
        break;
      }
      if (child == null) continue;
      count = visit(child, path + '.' + i, depth + 1, out, count);
      child.recycle();
    }
    return count;
  }

  /** Reads the logical display size, which already accounts for the current rotation. */
  private static int[] displaySize() {
    try {
      Object manager =
          Class.forName("android.hardware.display.DisplayManagerGlobal")
              .getMethod("getInstance")
              .invoke(null);
      Object info =
          manager.getClass().getMethod("getDisplayInfo", int.class).invoke(manager, 0);
      Class<?> type = info.getClass();
      int width = type.getField("logicalWidth").getInt(info);
      int height = type.getField("logicalHeight").getInt(info);
      int rotation = type.getField("rotation").getInt(info);
      if (width > 0 && height > 0) return new int[] {width, height, rotation};
    } catch (Throwable ignored) {
      // Fall through to the platform agnostic default below.
    }
    return null;
  }

  private static String quote(String value) {
    StringBuilder out = new StringBuilder(value.length() + 2);
    out.append('"');
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      switch (c) {
        case '"':
          out.append("\\\"");
          break;
        case '\\':
          out.append("\\\\");
          break;
        case '\n':
          out.append("\\n");
          break;
        case '\r':
          out.append("\\r");
          break;
        case '\t':
          out.append("\\t");
          break;
        default:
          if (c < 0x20 || c == 0x7f) {
            out.append(String.format("\\u%04x", (int) c));
          } else {
            out.append(c);
          }
      }
    }
    out.append('"');
    return out.toString();
  }
}
