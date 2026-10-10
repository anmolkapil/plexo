import { useEffect } from 'react'
import { useAppStore } from '../store/useAppStore'
import { acceptedLink } from '../utils/format'

/** Opens New download with links handed to Plexo, for the user to look at and start. */
export function useOpenedLinks(): void {
  const receiveLinks = useAppStore((store) => store.receiveLinks)

  useEffect(() => {
    const unsubscribe = window.plexo.onLinkReceived(() => void receiveLinks())
    // Some may have arrived before the window was listening.
    void receiveLinks()
    return unsubscribe
  }, [receiveLinks])
}

const isMac = window.plexo.platform === 'darwin'

/** The ways into New download from anywhere in the window, as download managers have them:
 * pasting a link (outside a text field), ⌘N / Ctrl+N, and dropping a link or a .torrent. */
export function useNewDownloadShortcuts(): void {
  const openNewDownload = useAppStore((store) => store.openNewDownload)

  useEffect(() => {
    const busy = (target: EventTarget | null): boolean =>
      useAppStore.getState().newDownloadOpen ||
      (target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA'].includes(target.tagName)))

    const onPaste = (event: ClipboardEvent): void => {
      if (busy(event.target)) return
      const link = acceptedLink(event.clipboardData?.getData('text') ?? '')
      if (link) openNewDownload(link)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== 'n' || !(isMac ? event.metaKey : event.ctrlKey)) return
      if (useAppStore.getState().newDownloadOpen) return
      event.preventDefault()
      openNewDownload()
    }
    // Never let a drop navigate the window to what was dropped.
    const onDragOver = (event: DragEvent): void => event.preventDefault()
    const onDrop = (event: DragEvent): void => {
      event.preventDefault()
      const file = event.dataTransfer?.files[0]
      const link = file
        ? /\.torrent$/i.test(file.name)
          ? window.plexo.pathForFile(file)
          : null
        : acceptedLink(event.dataTransfer?.getData('text') ?? '')
      if (link) openNewDownload(link)
    }

    window.addEventListener('paste', onPaste)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('paste', onPaste)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('drop', onDrop)
    }
  }, [openNewDownload])
}
