// Installed-app discovery.
//
// Android exposes the launcher-visible components (`query-activities`) but not their labels, so a
// small seed map covers the apps an agent is usually asked to open and everything else is
// humanized from its package name. The package name is always offered as well, which is enough for
// a language model to recognise most apps.
import { shell } from './adb.mjs';

const SEED_LABELS = {
  'com.android.settings': 'Settings',
  'com.android.chrome': 'Chrome',
  'com.google.android.apps.photos': 'Photos',
  'com.google.android.gm': 'Gmail',
  'com.google.android.apps.maps': 'Maps',
  'com.google.android.youtube': 'YouTube',
  'com.google.android.apps.docs': 'Drive',
  'com.google.android.calendar': 'Calendar',
  'com.google.android.deskclock': 'Clock',
  'com.google.android.apps.messaging': 'Messages',
  'com.google.android.dialer': 'Phone',
  'com.google.android.contacts': 'Contacts',
  'com.google.android.apps.nbu.files': 'Files',
  'com.google.android.keep': 'Keep Notes',
  'com.google.android.apps.translate': 'Translate',
  'com.google.android.videos': 'Google TV',
  'com.google.android.apps.podcasts': 'Podcasts',
  'com.google.android.apps.youtube.music': 'YouTube Music',
  'com.google.android.apps.wellbeing': 'Digital Wellbeing',
  'com.google.android.apps.recorder': 'Recorder',
  'com.google.android.calculator': 'Calculator',
  'com.google.android.inputmethod.latin': 'Gboard',
  'com.google.android.packageinstaller': 'Package installer',
  'com.android.vending': 'Play Store',
  'com.android.camera': 'Camera',
  'com.android.camera2': 'Camera',
  'com.android.gallery3d': 'Gallery',
  'com.android.deskclock': 'Clock',
  'com.android.calendar': 'Calendar',
  'com.android.contacts': 'Contacts',
  'com.android.dialer': 'Phone',
  'com.android.mms': 'Messages',
  'com.android.email': 'Email',
  'com.android.documentsui': 'Files',
  'com.android.calculator2': 'Calculator',
  'com.android.soundrecorder': 'Recorder',
  'com.android.music': 'Music',
  'com.android.terminal': 'Terminal',
  'com.android.shell': 'Shell',
  'com.tencent.mm': 'WeChat',
  'com.tencent.mobileqq': 'QQ',
  'com.tencent.wework': 'WeCom',
  'com.eg.android.AlipayGphone': 'Alipay',
  'com.taobao.taobao': 'Taobao',
  'com.jingdong.app.mall': 'JD',
  'com.xingin.xhs': 'Xiaohongshu',
  'com.sina.weibo': 'Weibo',
  'com.ss.android.ugc.aweme': 'Douyin',
  'com.ss.android.article.news': 'Toutiao',
  'com.netease.cloudmusic': 'NetEase Cloud Music',
  'com.zhihu.android': 'Zhihu',
  'com.baidu.BaiduMap': 'Baidu Maps',
  'com.autonavi.minimap': 'Amap',
  'com.sdu.didi.psnger': 'DiDi',
  'tv.danmaku.bili': 'Bilibili',
  'com.spotify.music': 'Spotify',
  'com.whatsapp': 'WhatsApp',
  'org.telegram.messenger': 'Telegram',
  'com.instagram.android': 'Instagram',
  'com.facebook.katana': 'Facebook',
  'com.twitter.android': 'X',
  'com.discord': 'Discord',
  'com.slack': 'Slack',
  'com.Slack': 'Slack',
  'com.microsoft.teams': 'Teams',
  'com.microsoft.office.outlook': 'Outlook',
  'com.google.android.apps.authenticator2': 'Authenticator',
  'org.mozilla.firefox': 'Firefox',
  'com.brave.browser': 'Brave',
  'com.microsoft.emmx': 'Edge',
  'com.duckduckgo.mobile.android': 'DuckDuckGo',
  'com.github.android': 'GitHub',
  'com.termux': 'Termux',
  'org.fdroid.fdroid': 'F-Droid',
  'com.aurora.store': 'Aurora Store',
  'com.android.settings.intelligence': 'Settings',
  'com.nextcloud.client': 'Nextcloud',
  'com.sonelli.juicessh': 'JuiceSSH',
  'com.zerotier.one': 'ZeroTier One',
};

const PREFIXES = [
  'com.google.android.apps.',
  'com.google.android.',
  'com.android.',
  'org.chromium.',
  'com.microsoft.',
  'com.tencent.',
  'com.sec.android.',
  'com.samsung.android.',
  'org.mozilla.',
];

/** A readable fallback for packages that are not in the seed map. */
export function humanize(packageName) {
  let name = packageName;
  for (const prefix of PREFIXES)
    if (name.startsWith(prefix)) {
      name = name.slice(prefix.length);
      break;
    }
  if (name === packageName) {
    const parts = packageName.split('.');
    if (parts.length > 2) name = parts.slice(-2).join('.');
  }
  const last = name.split('.').filter(Boolean).at(-1) || packageName;
  const words = last
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  return words
    .split(/\s+/)
    .filter(Boolean)
    .map((word) =>
      word === word.toLowerCase() && word.length > 2
        ? word[0].toUpperCase() + word.slice(1)
        : word[0].toUpperCase() + word.slice(1),
    )
    .join(' ');
}

export function labelFor(packageName) {
  return SEED_LABELS[packageName] || humanize(packageName);
}

/**
 * Lists launcher-visible apps, de-duplicated by package and sorted by label.
 * Falls back to third-party packages when the activity query is unavailable.
 */
export async function listApps(adb, { include = [] } = {}) {
  let packages = await launcherPackages(adb);
  if (!packages.length) packages = await thirdPartyPackages(adb);
  const unique = [...new Set([...packages, ...include])].filter(Boolean);
  return unique
    .map((packageName) => ({ packageName, label: labelFor(packageName) }))
    .sort((left, right) => left.label.localeCompare(right.label));
}

async function launcherPackages(adb) {
  const output = await shell(adb, [
    'cmd',
    'package',
    'query-activities',
    '--brief',
    '-a',
    'android.intent.action.MAIN',
    '-c',
    'android.intent.category.LAUNCHER',
  ]).catch(() => '');
  const packages = new Set();
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)$/);
    if (match) packages.add(match[1]);
  }
  return [...packages];
}

async function thirdPartyPackages(adb) {
  const output = await shell(adb, ['pm', 'list', 'packages', '-3']).catch(() => '');
  return output
    .split('\n')
    .map((line) => line.trim().replace(/^package:/, ''))
    .filter(Boolean);
}

export async function isInstalled(adb, packageName) {
  const output = await shell(adb, ['pm', 'path', packageName]).catch(() => '');
  return /^package:/m.test(output);
}
