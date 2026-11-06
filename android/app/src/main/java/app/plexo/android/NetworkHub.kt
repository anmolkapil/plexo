package app.plexo.android

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import okhttp3.ConnectionPool
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Protocol
import java.net.InetAddress
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

enum class LinkKind(val label: String, val transport: Int) {
    WIFI("Wi-Fi", NetworkCapabilities.TRANSPORT_WIFI),
    CELLULAR("Mobile", NetworkCapabilities.TRANSPORT_CELLULAR),
    ETHERNET("Ethernet", NetworkCapabilities.TRANSPORT_ETHERNET),
}

/** One physical connection. Sockets made through [client] leave over this network only. */
class Link(val id: String, val kind: LinkKind, val network: Network, base: OkHttpClient) {
    val enabled = MutableStateFlow(true)
    val speed = MutableStateFlow(0L)
    val bytes = AtomicLong()

    @Volatile
    var alive = true

    val client: OkHttpClient = base.newBuilder()
        .socketFactory(network.socketFactory)
        .dns(object : Dns {
            override fun lookup(hostname: String): List<InetAddress> =
                network.getAllByName(hostname).toList()
        })
        .build()
}

/**
 * Asks Android to keep every kind of connection up at once (the OS normally keeps only the
 * "best" one) and tracks the ones that are available. This is what Plexo's per-interface
 * binding does on desktop, done the Android way: no root and no VPN.
 */
class NetworkHub(context: Context) {
    private val cm = context.getSystemService(ConnectivityManager::class.java)

    /** One TCP connection per request: HTTP/2 would funnel every stream into a single connection. */
    val base: OkHttpClient = OkHttpClient.Builder()
        .protocols(listOf(Protocol.HTTP_1_1))
        .connectionPool(ConnectionPool(32, 2, TimeUnit.MINUTES))
        .connectTimeout(12, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val _links = MutableStateFlow<List<Link>>(emptyList())
    val links: StateFlow<List<Link>> = _links

    private val byNetwork = HashMap<Network, Link>()
    private var started = false

    @Synchronized
    fun start() {
        if (started) return
        started = true
        for (kind in LinkKind.values()) {
            val request = NetworkRequest.Builder()
                .addTransportType(kind.transport)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()
            try {
                cm.requestNetwork(request, callbackFor(kind))
            } catch (_: SecurityException) {
                // Without CHANGE_NETWORK_STATE the OS keeps only its preferred network up.
            }
        }
    }

    private fun callbackFor(kind: LinkKind) = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            synchronized(this@NetworkHub) {
                byNetwork.getOrPut(network) {
                    Link("${kind.name}-${network.networkHandle}", kind, network, base)
                }
                publish()
            }
        }

        override fun onLost(network: Network) {
            synchronized(this@NetworkHub) {
                byNetwork.remove(network)?.alive = false
                publish()
            }
        }
    }

    private fun publish() {
        _links.value = byNetwork.values.sortedWith(compareBy({ it.kind }, { it.id }))
    }

    /** "Wi-Fi", or "Mobile 2" when a second one of the same kind is up. */
    fun nameOf(link: Link): String {
        val same = _links.value.filter { it.kind == link.kind }
        return if (same.size > 1) "${link.kind.label} ${same.indexOf(link) + 1}" else link.kind.label
    }
}
