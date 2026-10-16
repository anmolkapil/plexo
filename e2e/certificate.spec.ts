import { BLOCK, expect, test } from './fixtures'

// H. A server whose certificate the app can't verify — a self-signed one here. It used to be a
// dead end: the link check failed and Start stayed disabled, so the file couldn't be downloaded
// at all, though the browser on the same machine serves it (Node verifies against its own bundle
// of roots, which need not include one the operating system, and so the browser, trusts).
// "Download anyway" is what the user answers that with, and it only ever applies to the link they
// answered it for.

/** The destination picker goes through native OS UI — replace it, as ui.spec.ts does. */
async function stubDestination(
  plexo: import('./fixtures').PlexoApp,
  destination: string
): Promise<void> {
  await plexo.evaluateMain(({ dialog }, dest) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dest] })) as never
  }, destination)
}

test.describe('a certificate the app cannot verify @smoke', () => {
  test('the link check refuses it, and passes once the certificate is accepted', async ({
    plexo,
    serve
  }) => {
    const origin = await serve({ size: 2 * BLOCK, tls: true })

    // What New download runs as the link is typed: refused, with the message the dialog shows.
    await expect(plexo.api.probeUrl(origin.url())).rejects.toThrow(/certificate/i)
    // What "Download anyway" does: the same link again, without the certificate being verified.
    const probe = await plexo.api.probeUrl(origin.url(), { allowInvalidCertificate: true })
    expect(probe.kind).toBe('http')
    expect(probe.totalBytes).toBe(2 * BLOCK)
  })

  test('a download accepted that way runs to the end', async ({ plexo, serve }) => {
    const origin = await serve({ size: 3 * BLOCK, tls: true })

    await plexo.start(origin.url(), origin.sha256, { allowInvalidCertificate: true })
    const state = await plexo.waitForHttpStatus('completed')
    // The automatic checks compare the file with the source byte for byte.
    expect(state.bytesDownloaded).toBe(3 * BLOCK)
  })

  test('New download offers Download anyway, and it starts', async ({ plexo, serve, dirs }) => {
    const origin = await serve({ size: BLOCK, tls: true })
    await stubDestination(plexo, dirs.dest)
    const page = plexo.page
    const start = page.getByRole('button', { name: 'Download', exact: true })

    await (await plexo.newDownload()).fill(origin.url())
    await expect(page.getByText(/security certificate/i)).toBeVisible()
    // Nothing is accepted yet, so the download can't be started.
    await expect(start).toBeDisabled()

    await page.getByRole('button', { name: 'Change' }).click()
    await plexo.expectNextDownload(origin.sha256)
    await page.getByRole('button', { name: 'Download anyway', exact: true }).click()
    // The link was checked again without the certificate, and the file is now known.
    await expect(start).toBeEnabled()
    await start.click()
    await plexo.waitForHttpStatus('completed')
  })
})
