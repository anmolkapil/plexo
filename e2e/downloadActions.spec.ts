import { expect, test } from '@playwright/test'
import type { DownloadState, FinishedDownload } from '../src/shared/types'
import {
  availableActions,
  failureAction,
  headerActions,
  manageAction,
  manageActions,
  rowAction,
  type ActionId,
  type DownloadItem
} from '../src/renderer/src/utils/downloadActions'

function download(
  patch: Partial<DownloadState> & { status: DownloadState['status'] }
): DownloadItem {
  return {
    id: 'a',
    kind: 'http',
    url: 'https://example.com/f.bin',
    fileName: 'f.bin',
    bytesDownloaded: 100,
    totalBytes: 1000,
    ...patch
  } as unknown as DownloadItem
}

function finished(patch: Partial<FinishedDownload> = {}): DownloadItem {
  return {
    ...(download({ status: 'completed' }) as object),
    unitsWritten: 4,
    ...patch
  } as unknown as DownloadItem
}

const ids = (items: DownloadItem[]): ActionId[] =>
  availableActions(items).flatMap((group) => group.map((action) => action.id))

test.describe('what each state offers', () => {
  test('downloading and queued', () => {
    for (const status of ['downloading', 'queued'] as const)
      expect(ids([download({ status })])).toEqual(['pause', 'reveal', 'copy', 'cancel'])
  })

  test('paused', () => {
    expect(ids([download({ status: 'paused' })])).toEqual(['resume', 'reveal', 'copy', 'cancel'])
  })

  test('failed with saved data can be retried', () => {
    expect(ids([download({ status: 'error', error: 'reset' })])).toEqual([
      'retry',
      'copy',
      'remove'
    ])
  })

  test('failed with a refused link can be fixed', () => {
    const item = download({
      status: 'error',
      error: 'Server answered with status 403 for range request'
    })
    expect(failureAction(item as DownloadState)).toBe('fix')
    expect(ids([item])).toEqual(['fix', 'copy', 'remove'])
  })

  test('failed with nothing to resume starts over', () => {
    expect(ids([download({ status: 'error', error: 'reset', resumable: false })])).toEqual([
      'again',
      'copy',
      'remove'
    ])
    expect(ids([download({ status: 'error', error: 'reset', bytesDownloaded: 0 })])).toEqual([
      'again',
      'copy',
      'remove'
    ])
  })

  test('completed', () => {
    expect(ids([download({ status: 'completed' })])).toEqual([
      'open',
      'reveal',
      'copy',
      'remove',
      'trash'
    ])
    expect(ids([finished()])).toEqual(['open', 'reveal', 'copy', 'remove', 'trash'])
  })

  test('completed but moved: nothing that needs the file', () => {
    expect(ids([finished({ missing: true })])).toEqual(['copy', 'remove'])
  })

  test('a torrent from a .torrent file has no link to copy', () => {
    const torrent = download({ status: 'paused', kind: 'torrent', url: '/tmp/a.torrent' })
    expect(ids([torrent])).toEqual(['resume', 'reveal', 'cancel'])
  })
})

test.describe('several selected', () => {
  test('an action acts on just the ones it is valid for', () => {
    const items = [
      download({ id: 'a', status: 'downloading' }),
      download({ id: 'b', status: 'paused' }),
      download({ id: 'c', status: 'queued' }),
      finished({ id: 'd' })
    ]
    const found = Object.fromEntries(
      availableActions(items)
        .flat()
        .map((action) => [action.id, action.targets.map((target) => target.id)])
    )
    expect(found.pause).toEqual(['a', 'c'])
    expect(found.resume).toEqual(['b'])
    expect(found.cancel).toEqual(['a', 'b', 'c'])
    expect(found.remove).toEqual(['d'])
  })

  test('single-download actions are not offered for several', () => {
    const items = [finished({ id: 'a' }), finished({ id: 'b' })]
    expect(ids(items)).toEqual(['copy', 'remove', 'trash'])
    const failed = [
      download({
        id: 'a',
        status: 'error',
        error: 'Server answered with status 403 for range request'
      }),
      download({
        id: 'b',
        status: 'error',
        error: 'Server answered with status 403 for range request'
      })
    ]
    expect(ids(failed)).toEqual(['copy', 'remove'])
  })
})

test.describe('the places that show them agree', () => {
  test('a row button, a screen header and the menu start from the same list', () => {
    const states = [
      download({ status: 'downloading' }),
      download({ status: 'paused' }),
      download({ status: 'error', error: 'reset' }),
      download({ status: 'error', error: 'Server answered with status 403 for range request' }),
      download({ status: 'error', error: 'reset', resumable: false }),
      finished()
    ]
    for (const item of states) {
      const menu = ids([item])
      const row = rowAction(item)
      if (row) expect(menu).toContain(row)
      for (const id of headerActions(item)) expect(menu).toContain(id)
      const manage = manageAction(item)
      if (manage) expect(menu).toContain(manage)
      // The first thing a menu offers is what its row button does.
      if (row) expect(menu[0]).toBe(row)
    }
  })

  test('a finished download can be removed or have its file trashed, from its own screen too', () => {
    expect(manageActions(finished())).toEqual(['remove', 'trash'])
    expect(manageActions(finished({ missing: true }))).toEqual(['remove'])
    expect(manageActions(download({ status: 'paused' }))).toEqual(['cancel'])
    expect(manageActions(download({ status: 'error', error: 'x' }))).toEqual(['remove'])
  })

  test('a download that is going can be cancelled, one that is over can be removed', () => {
    expect(manageAction(download({ status: 'paused' }))).toBe('cancel')
    expect(manageAction(download({ status: 'error', error: 'x' }))).toBe('remove')
    expect(manageAction(finished())).toBe('remove')
  })
})
