// ponytail: typed by hand, only what's called; swap for @types/chrome once it's a devDependency.
// Firefox takes `chrome.*` too, with promises.

declare namespace chrome {
  interface Event<T> {
    addListener(callback: T): void
  }

  namespace runtime {
    function getManifest(): { version: string }
    function openOptionsPage(): Promise<void>
    function sendMessage(message: unknown): Promise<unknown>
    const onInstalled: Event<() => void>
    const onStartup: Event<() => void>
    const onMessage: Event<(message: unknown) => void>
  }

  namespace downloads {
    interface DownloadItem {
      id: number
      url: string
      finalUrl?: string
      referrer?: string
      incognito: boolean
      /** Firefox only. */
      cookieStoreId?: string
    }
    function cancel(id: number): Promise<void>
    function erase(query: { id: number }): Promise<number[]>
    const onCreated: Event<(item: DownloadItem) => void>
    /** Chromium only. */
    const onDeterminingFilename:
      Event<(item: DownloadItem, suggest: () => void) => boolean | void> | undefined
  }

  namespace cookies {
    interface Cookie {
      name: string
      value: string
      domain: string
      hostOnly: boolean
      path: string
      secure: boolean
    }
    function getAll(details: { url: string; storeId?: string }): Promise<Cookie[]>
  }

  namespace tabs {
    interface Tab {
      id?: number
      url?: string
      pendingUrl?: string
      incognito: boolean
      /** Firefox only. */
      cookieStoreId?: string
    }
    function query(info: { active?: boolean; currentWindow?: boolean }): Promise<Tab[]>
    function create(props: { url: string; active?: boolean }): Promise<Tab>
    function remove(id: number): Promise<void>
    const onCreated: Event<(tab: Tab) => void>
  }

  namespace contextMenus {
    interface OnClickData {
      menuItemId: string | number
      linkUrl?: string
      pageUrl?: string
    }
    function create(props: { id: string; title: string; contexts: string[] }): void
    function removeAll(): Promise<void>
    const onClicked: Event<(info: OnClickData, tab?: tabs.Tab) => void>
  }

  namespace storage {
    const local: {
      get(defaults: object): Promise<Record<string, unknown>>
      set(items: object): Promise<void>
    }
    const onChanged: Event<() => void>
  }

  namespace action {
    function setIcon(details: { path: Record<number, string> }): Promise<void>
    function setTitle(details: { title: string }): Promise<void>
  }

  namespace alarms {
    function create(name: string, info: { periodInMinutes: number }): Promise<void>
    const onAlarm: Event<(alarm: { name: string }) => void>
  }

  namespace permissions {
    function contains(permissions: { origins: string[] }): Promise<boolean>
    function request(permissions: { origins: string[] }): Promise<boolean>
  }
}
