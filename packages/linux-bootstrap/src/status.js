/**
 * Presentation strings for the external Linux environment settings section.
 *
 * Kept free of React so the wording and the state derivation can be tested
 * without a DOM (the release gate runs `node --test` with no UI dependencies).
 */

/** The opt-in statement shown at the top of the section. */
export const EXTERNAL_NOTICE =
  '外部插件（external）：不属于 DSH Mobile 本体，默认不启用。' +
  '只有你手动把插件放入注入目录并明确安装后，Linux 环境才会启用；' +
  '应用更新或 Linux 新版本发布都不会自动启用它。'

/**
 * Render the current Linux environment state as one line of user-facing text.
 *
 * @param {object|null|undefined} status - `linuxBootstrap.status()` payload.
 * @returns {string} State summary.
 */
export function describeVersionStatus(status) {
  if (!status) return '正在读取 Linux 环境状态…'
  if (!status.installed) {
    return status.updateBlocked
      ? '尚未安装 Linux 环境；发现较旧的 Linux 版本，已阻止降级'
      : '尚未安装 Linux 环境（外部插件，默认不启用）'
  }
  const installed = `已安装 Linux 运行时 ${status.version}`
  const appVersion = status.mobileVersion ? `；当前 DSH Mobile ${status.mobileVersion}` : ''
  const baseline = status.installedSystemMobileVersion
    ? `（安装时 DSH Mobile ${status.installedSystemMobileVersion}）`
    : ''
  const activation = status.injectionActivated ? '' : '；插件已不在注入目录中，自动更新已停止'
  if (status.updateAvailable) {
    return `${installed}${appVersion}${baseline}；可更新至 ${status.availableVersion}${activation}`
  }
  if (status.updateBlocked) {
    return `${installed}${appVersion}${baseline}；${status.error ?? '已阻止降级'}${activation}`
  }
  if (status.error) return `${installed}${appVersion}${baseline}；${status.error}${activation}`
  return `${installed}${appVersion}${baseline}${activation}`
}

/**
 * Whether the auto-update control should be operable.
 *
 * Auto-update is meaningless (and must stay off) until a Linux runtime is
 * actually installed and still injected.
 *
 * @param {object|null|undefined} status - `linuxBootstrap.status()` payload.
 * @returns {boolean} True when the control may be toggled.
 */
export function autoUpdateAvailable(status) {
  return Boolean(status?.installed)
}
