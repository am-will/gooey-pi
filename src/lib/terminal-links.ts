export function terminalLinkOpensExternally(event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'>): boolean {
  return event.metaKey || event.ctrlKey
}
