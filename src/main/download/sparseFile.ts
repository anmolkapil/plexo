import type { IKoffiLib } from 'koffi'

// On NTFS a write past the last byte written so far first fills the gap with zeros, on disk,
// while the write waits (https://devblogs.microsoft.com/oldnewthing/20110922-00/?p=9573). Streams
// start all over the staging file, so a block's first write could zero megabytes ahead of it, and
// most of the file would be written twice. A sparse file has no gap to fill: what hasn't been
// written reads as zeros. Node can't ask for it, so it's asked of kernel32. Only an
// optimisation: a file system without sparse files (exFAT, FAT32) refuses, and the file stays
// as it was.

const GENERIC_WRITE = 0x40000000
const SHARE_ALL = 0x7 // read, write and delete: nobody else's handle is disturbed
const OPEN_EXISTING = 3
const FSCTL_SET_SPARSE = 0x900c4
const INVALID_HANDLE = BigInt.asUintN(64, -1n)

type KoffiFunction = ReturnType<IKoffiLib['func']>

interface Kernel32 {
  createFile: KoffiFunction
  deviceIoControl: KoffiFunction
  closeHandle: KoffiFunction
  address: (handle: unknown) => bigint
}

let kernel32: Promise<Kernel32 | null> | null = null

function load(): Promise<Kernel32 | null> {
  kernel32 ??= (async () => {
    try {
      const { default: koffi } = await import('koffi')
      const lib = koffi.load('kernel32.dll')
      return {
        createFile: lib.func(
          'void * __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *template)'
        ),
        deviceIoControl: lib.func(
          'int __stdcall DeviceIoControl(void *handle, uint32_t code, void *input, uint32_t inputSize, void *output, uint32_t outputSize, _Out_ uint32_t *returned, void *overlapped)'
        ),
        closeHandle: lib.func('int __stdcall CloseHandle(void *handle)'),
        address: (handle) => koffi.address(handle)
      }
    } catch (error) {
      console.warn('Sparse staging files unavailable:', error)
      return null
    }
  })()
  return kernel32
}

const call = <T>(fn: KoffiFunction, ...args: unknown[]): Promise<T> =>
  new Promise((resolve, reject) =>
    fn.async(...args, (error: unknown, result: T) => (error ? reject(error) : resolve(result)))
  )

/** Makes the file at `path` sparse on Windows; whether it did. Never throws. */
export async function markSparse(path: string): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const lib = await load()
  if (!lib) return false
  try {
    const handle = await call<unknown>(
      lib.createFile,
      path,
      GENERIC_WRITE,
      SHARE_ALL,
      null,
      OPEN_EXISTING,
      0,
      null
    )
    if (lib.address(handle) === INVALID_HANDLE) return false
    try {
      const returned = [0]
      const ok = await call<number>(
        lib.deviceIoControl,
        handle,
        FSCTL_SET_SPARSE,
        null,
        0,
        null,
        0,
        returned,
        null
      )
      return ok !== 0
    } finally {
      await call(lib.closeHandle, handle)
    }
  } catch {
    return false
  }
}
