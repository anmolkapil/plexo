import { lookup } from 'node:dns/promises'
import {
  Agent as HttpAgent,
  request as httpRequest,
  type ClientRequest,
  type ClientRequestArgs,
  type IncomingMessage
} from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { isIP, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { IpFamily, NetworkInterfaceInfo } from '../../shared/types'
import { connectRoute } from './deviceBinding'

export interface NetworkRoute {
  device: string
  localAddress: string
  remoteAddress: string
  family: IpFamily
}

export type RemoteAddress = { address: string; family: IpFamily }

/** Test seam for an AAAA-only hostname without modifying system DNS. */
type ResolveHost = (host: string) => Promise<RemoteAddress[]>

/** URL.hostname brackets IPv6 literals; sockets and isIP expect the unbracketed address. */
export function targetHost(target: URL): string {
  return target.hostname.replace(/^\[|\]$/g, '')
}

async function resolveTarget(
  host: string,
  resolveHost: ResolveHost = async (name) =>
    (await lookup(name, { all: true, order: 'verbatim' })) as RemoteAddress[]
): Promise<RemoteAddress[]> {
  const literalFamily = isIP(host)
  if (literalFamily) return [{ address: host, family: literalFamily as IpFamily }]
  return resolveHost(host)
}

/** Preserve DNS and OS address order; each route always has matching IP families. */
export function routesFor(
  iface: NetworkInterfaceInfo,
  remoteAddresses: RemoteAddress[]
): NetworkRoute[] {
  return remoteAddresses.flatMap((remote) =>
    iface.addresses
      .filter((local) => local.family === remote.family)
      .map((local) => ({
        device: iface.device,
        localAddress: local.address,
        remoteAddress: remote.address,
        family: remote.family
      }))
  )
}

export function compatibleInterfaces(
  interfaces: NetworkInterfaceInfo[],
  remoteAddresses: RemoteAddress[]
): NetworkInterfaceInfo[] {
  return interfaces.filter((iface) => routesFor(iface, remoteAddresses).length > 0)
}

export class NoCompatibleRouteError extends Error {
  constructor(host: string) {
    super(`No selected network has an address compatible with ${host}`)
  }
}

/** The connection failed — it couldn't be opened, or it dropped or went silent before the
 * server had finished — rather than the server answering wrongly. It says something about the
 * network, not the server, so a download never gives up on it (see downloadManager.ts). */
export class ConnectionError extends Error {
  constructor(cause: Error) {
    super(cause.message, { cause })
  }
}

/** `error` as a ConnectionError, unless it is one already or means something else: an abort,
 * or a network that has no route to the host. */
export function asConnectionError(error: unknown): Error {
  if (error instanceof ConnectionError || error instanceof NoCompatibleRouteError) return error
  if (error instanceof Error && error.name === 'AbortError') return error
  return new ConnectionError(error instanceof Error ? error : new Error(String(error)))
}

/** DNS is part of opening a connection, so it must not outlive the connection's deadline. */
export function resolveTargetWithin(
  host: string,
  timeoutMs: number,
  signal?: AbortSignal,
  resolveHost?: ResolveHost
): Promise<RemoteAddress[]> {
  return new Promise((resolve, reject) => {
    let done = false
    const finish = (complete: () => void): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      complete()
    }
    const onAbort = (): void => finish(() => reject(abortError()))
    const timer = setTimeout(
      () => finish(() => reject(new Error('Could not resolve the download host in time'))),
      timeoutMs
    )
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    void resolveTarget(host, resolveHost).then(
      (addresses) => finish(() => resolve(addresses)),
      (error) => finish(() => reject(error))
    )
  })
}

const abortError = (): DOMException => new DOMException('Aborted', 'AbortError')

// RFC 8305 (Happy Eyeballs): each next address starts this long after the one before, unless
// that one has already failed, and the first to finish its handshake wins. An address that
// doesn't answer (IPv6 with no way out, a stale record) then costs a new connection 250 ms, not
// its whole timeout. It is also Node's autoSelectFamilyAttemptTimeout.
const ATTEMPT_DELAY_MS = 250

/** By network and host, the route that last connected: where the next connection starts. */
const lastGoodRoute = new Map<string, string>()
const routeKey = (route: NetworkRoute): string => `${route.localAddress} ${route.remoteAddress}`

/** The route that last worked first, then the rest alternating between address families, as
 * RFC 8305 §4 orders them. */
function attemptOrder(routes: NetworkRoute[], preferred: string | undefined): NetworkRoute[] {
  const first = routes.find((route) => routeKey(route) === preferred)
  const rest = routes.filter((route) => route !== first)
  const families = [...new Set(rest.map((route) => route.family))]
  const byFamily = families.map((family) => rest.filter((route) => route.family === family))
  const ordered: NetworkRoute[] = first ? [first] : []
  for (let i = 0; byFamily.some((list) => i < list.length); i++) {
    for (const list of byFamily) if (i < list.length) ordered.push(list[i])
  }
  return ordered
}

/**
 * A socket to `host` through `iface`, racing its compatible routes as RFC 8305 does: whichever
 * completes its handshake first is kept, and the others are dropped. `secure` wraps the TCP
 * socket in TLS before that point, so a route whose TLS handshake never finishes is given up on
 * just like one that never connects.
 */
async function connectOnInterface(
  iface: NetworkInterfaceInfo,
  host: string,
  port: number,
  secure: ((socket: Socket) => Socket) | null,
  timeoutMs: number,
  signal: AbortSignal,
  resolveHost?: ResolveHost
): Promise<Socket> {
  const deadline = Date.now() + timeoutMs
  const found = routesFor(iface, await resolveTargetWithin(host, timeoutMs, signal, resolveHost))
  if (found.length === 0) throw new NoCompatibleRouteError(host)
  const memory = `${iface.id} ${host}:${port}`
  const routes = attemptOrder(found, lastGoodRoute.get(memory))

  return new Promise<Socket>((resolve, reject) => {
    const racing = new Set<{ tcp: Socket; socket: Socket }>()
    let next = 0
    let done = false
    let lastError: Error = new Error('Connection failed')
    let stagger: NodeJS.Timeout | undefined

    const finish = (error: Error | null, winner?: Socket): void => {
      if (done) return
      done = true
      clearTimeout(stagger)
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      for (const { tcp, socket } of racing) {
        socket.destroy()
        tcp.destroy()
      }
      racing.clear()
      if (winner) resolve(winner)
      else reject(error)
    }
    const onAbort = (): void => finish(abortError())
    const timer = setTimeout(
      () => finish(new Error('Connection stalled: could not connect')),
      Math.max(1, deadline - Date.now())
    )

    const launch = (): void => {
      clearTimeout(stagger)
      if (done || next >= routes.length) return
      const route = routes[next++]
      const tcp = connectRoute(route, port)
      const socket = secure ? secure(tcp) : tcp
      const entry = { tcp, socket }
      racing.add(entry)
      const connected = secure ? 'secureConnect' : 'connect'

      const detach = (): void => {
        socket.off(connected, onConnected)
        socket.off('error', onError)
        tcp.off('error', onError)
        racing.delete(entry)
      }
      const onConnected = (): void => {
        detach()
        lastGoodRoute.set(memory, routeKey(route))
        finish(null, socket)
      }
      const onError = (error: Error): void => {
        detach()
        socket.destroy()
        tcp.destroy()
        lastError = error
        if (lastGoodRoute.get(memory) === routeKey(route)) lastGoodRoute.delete(memory)
        // A route that fails hands over at once rather than after its delay.
        if (next < routes.length) launch()
        else if (racing.size === 0) finish(lastError)
      }
      socket.once(connected, onConnected)
      // A refused TCP connection is reported on the raw socket, not always on its TLS wrapper.
      socket.once('error', onError)
      tcp.once('error', onError)
      if (next < routes.length) stagger = setTimeout(launch, ATTEMPT_DELAY_MS)
    }

    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
    launch()
  })
}

/** What a request passes its agent: Node hands a request's options to the agent's
 * createConnection, so a connection opened for a request can be dropped with it. */
type ConnectOptions = ClientRequestArgs & { connectSignal?: AbortSignal }

type Open = (
  options: ConnectOptions,
  secure: ((socket: Socket) => Socket) | null
) => Promise<Socket>

type OnCreate = (err: Error | null, stream: Duplex) => void

// Node's agents keep sockets alive and pool them; these only change how a new one is opened.
class RoutedHttpAgent extends HttpAgent {
  constructor(private readonly open: Open) {
    super({ keepAlive: true })
  }

  override createConnection(options: ConnectOptions, callback?: OnCreate): undefined {
    this.open(options, null).then(
      (socket) => callback?.(null, socket),
      (error: Error) => callback?.(error, undefined as never)
    )
    return undefined
  }
}

class RoutedHttpsAgent extends HttpsAgent {
  constructor(private readonly open: Open) {
    super({ keepAlive: true })
  }

  override createConnection(options: ConnectOptions, callback?: OnCreate): undefined {
    // The agent's own TLS setup, around our routed socket: it verifies the certificate against
    // the URL's host and caches the TLS session, so a reconnect resumes it instead of redoing
    // the full handshake.
    this.open(
      options,
      (socket) => super.createConnection({ ...options, socket } as ClientRequestArgs) as Socket
    ).then(
      (socket) => callback?.(null, socket),
      (error: Error) => callback?.(error, undefined as never)
    )
    return undefined
  }
}

export interface ResponseStart {
  req: ClientRequest
  res: IncomingMessage
  /** When the request was sent. */
  sentAt: number
}

/**
 * One download stream's connection to the server, through one network. Requests reuse a single
 * kept-alive socket, so a stream pays for DNS, the TCP and TLS handshakes and TCP slow start once
 * rather than on every block. A new socket is only opened when there is none to reuse: the first
 * request, after the server closes an idle one, or after an abort destroyed it, which is how a
 * stuck connection gets swapped for a fresh one.
 *
 * Every new socket asks for the network as it is now, so one that comes back with a new
 * address is reached at that one.
 */
export class StreamConnection {
  private readonly lifetime = new AbortController()
  private readonly http: HttpAgent
  private readonly https: HttpsAgent

  private readonly timeoutMs: number

  constructor(
    /** The network, or undefined while it isn't connected. */
    network: () => NetworkInterfaceInfo | undefined,
    {
      timeoutMs,
      connectTimeoutMs = timeoutMs,
      resolveHost
    }: {
      /** How long a request may take to get its response headers, connecting included. */
      timeoutMs: number
      /** How long opening a socket may take: DNS, TCP and TLS. Shorter than `timeoutMs`, so a
       * network that can't get through is found out before a slow server would be. */
      connectTimeoutMs?: number
      resolveHost?: ResolveHost
    }
  ) {
    this.timeoutMs = timeoutMs
    const open: Open = async (options, secure) => {
      const iface = network()
      if (!iface) throw new Error('The network is not connected')
      return connectOnInterface(
        iface,
        options.host ?? '',
        Number(options.port),
        secure,
        Math.min(connectTimeoutMs, timeoutMs),
        // Given up on when its request is, not only when the stream closes: a request abandoned
        // mid-connect (a stuck connection being replaced) shouldn't leave a handshake running.
        options.connectSignal
          ? AbortSignal.any([this.lifetime.signal, options.connectSignal])
          : this.lifetime.signal,
        resolveHost
      )
    }
    this.http = new RoutedHttpAgent(open)
    this.https = new RoutedHttpsAgent(open)
  }

  request(
    target: URL,
    headers: Record<string, string>,
    signal?: AbortSignal
  ): Promise<ResponseStart> {
    return this.send(target, headers, signal, true)
  }

  /** Drops its sockets, in use or kept for reuse, so the next request opens a new one: they may
   * be bound to an address the network no longer has, or have died while the computer slept.
   * Unlike close, it stays usable. */
  reconnect(): void {
    this.http.destroy()
    this.https.destroy()
  }

  /** Closes its sockets, and gives up on any still connecting. */
  close(): void {
    this.lifetime.abort()
    this.http.destroy()
    this.https.destroy()
  }

  private send(
    target: URL,
    headers: Record<string, string>,
    signal: AbortSignal | undefined,
    retryStale: boolean
  ): Promise<ResponseStart> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortError())
      const secure = target.protocol === 'https:'
      const sentAt = Date.now()
      let answered = false
      let timedOut = false
      const options: ConnectOptions = {
        method: 'GET',
        hostname: targetHost(target),
        port: target.port || undefined,
        path: `${target.pathname}${target.search}`,
        headers,
        agent: secure ? this.https : this.http,
        connectSignal: signal
      }
      const req = (secure ? httpsRequest : httpRequest)(options, (res) => {
        answered = true
        settle()
        resolve({ req, res, sentAt })
      })
      const onAbort = (): void => void req.destroy(abortError())
      const timer = setTimeout(() => {
        timedOut = true
        req.destroy(new Error('Connection stalled: no response from server'))
      }, this.timeoutMs)
      const settle = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      req.on('error', (error) => {
        if (answered) return // The response's owner handles errors from here on.
        settle()
        // A kept-alive socket the server closed while it sat idle only fails once used, so the
        // request gets one more go on a new socket (the retry Node documents for `reusedSocket`).
        if (retryStale && req.reusedSocket && !timedOut && !signal?.aborted) {
          resolve(this.send(target, headers, signal, false))
        } else {
          reject(asConnectionError(error))
        }
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      req.end()
    })
  }
}
