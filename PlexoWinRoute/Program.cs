using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

internal static class Program
{
    private const int IpUnicastIf = 31;
    private const int MaxHeader = 4096;

    private record RouteRequest(string Token, string RemoteAddress, int RemotePort, string LocalAddress);

    private static async Task Main()
    {
        // The session token travels over stdin, not a process command line visible to other apps.
        var token = await Console.In.ReadLineAsync();
        if (string.IsNullOrEmpty(token) || token.Length < 32) throw new ArgumentException("Session token required");

        using var shutdown = new CancellationTokenSource();
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        _ = WatchParentStdin(shutdown, listener);
        Console.WriteLine($"READY {((IPEndPoint)listener.LocalEndpoint).Port}");
        Console.Out.Flush();

        try
        {
            while (!shutdown.IsCancellationRequested)
            {
                var client = await listener.AcceptTcpClientAsync(shutdown.Token);
                _ = Handle(client, token);
            }
        }
        catch (OperationCanceledException) when (shutdown.IsCancellationRequested) { }
        catch (SocketException) when (shutdown.IsCancellationRequested) { }
    }

    private static async Task WatchParentStdin(CancellationTokenSource shutdown, TcpListener listener)
    {
        try
        {
            var buffer = new char[1];
            while (await Console.In.ReadAsync(buffer.AsMemory()) != 0) { }
        }
        catch (IOException) { }
        finally
        {
            shutdown.Cancel();
            listener.Stop();
        }
    }

    // The address chosen in Plexo, not a cached PowerShell result, is the source of truth.
    // This also handles adapters that are renamed or reconnect while Plexo is running.
    private static int InterfaceIndexFor(IPAddress source)
    {
        foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
        {
            var properties = nic.GetIPProperties();
            if (!properties.UnicastAddresses.Any(address => address.Address.Equals(source))) continue;
            var index = properties.GetIPv4Properties()?.Index ?? 0;
            if (index > 0) return index;
        }
        return 0;
    }

    private static string NodeError(SocketError error) => error switch
    {
        SocketError.ConnectionRefused => "ECONNREFUSED",
        SocketError.TimedOut => "ETIMEDOUT",
        SocketError.NetworkUnreachable => "ENETUNREACH",
        SocketError.HostUnreachable => "EHOSTUNREACH",
        SocketError.AddressNotAvailable => "EADDRNOTAVAIL",
        SocketError.AddressAlreadyInUse => "EADDRINUSE",
        SocketError.AccessDenied => "EACCES",
        SocketError.NetworkDown => "ENETDOWN",
        SocketError.ConnectionReset => "ECONNRESET",
        _ => "EIO"
    };

    private static async Task WriteError(TcpClient client, string code)
    {
        try
        {
            await client.GetStream().WriteAsync(Encoding.ASCII.GetBytes($"ERR {code}\n"));
        }
        catch (Exception) { /* The requester may already have disconnected. */ }
    }

    private static async Task Pump(Stream input, Stream output, Socket destination)
    {
        try { await input.CopyToAsync(output); }
        catch (IOException) { }
        catch (SocketException) { }
        finally
        {
            try { destination.Shutdown(SocketShutdown.Send); }
            catch (SocketException) { }
            catch (ObjectDisposedException) { }
        }
    }

    private static async Task Handle(TcpClient client, string token)
    {
        using (client)
        {
            var acknowledged = false;
            try
            {
                client.NoDelay = true;
                using var inbound = client.GetStream();
                using var header = new MemoryStream();
                var one = new byte[1];
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
                while (header.Length < MaxHeader)
                {
                    if (await inbound.ReadAsync(one, timeout.Token) == 0) return;
                    if (one[0] == (byte)'\n') break;
                    header.WriteByte(one[0]);
                }
                if (header.Length >= MaxHeader) return;
                var request = JsonSerializer.Deserialize<RouteRequest>(header.ToArray(),
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                if (request == null || request.Token != token) return;
                if (request.RemotePort is < 1 or > 65535) return;
                var remote = IPAddress.Parse(request.RemoteAddress);
                var local = IPAddress.Parse(request.LocalAddress);
                if (remote.AddressFamily != AddressFamily.InterNetwork ||
                    local.AddressFamily != AddressFamily.InterNetwork) return;

                var interfaceIndex = InterfaceIndexFor(local);
                if (interfaceIndex < 1)
                {
                    await WriteError(client, "ENODEV");
                    return;
                }
                using var outbound = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
                outbound.NoDelay = true;
                outbound.SetSocketOption(SocketOptionLevel.IP, (SocketOptionName)IpUnicastIf,
                    IPAddress.HostToNetworkOrder(interfaceIndex));
                outbound.Bind(new IPEndPoint(local, 0));
                await outbound.ConnectAsync(new IPEndPoint(remote, request.RemotePort), timeout.Token);
                await inbound.WriteAsync(Encoding.ASCII.GetBytes($"OK {interfaceIndex}\n"), timeout.Token);
                acknowledged = true;

                using var outgoing = new NetworkStream(outbound, ownsSocket: false);
                await Task.WhenAll(
                    Pump(inbound, outgoing, outbound),
                    Pump(outgoing, inbound, client.Client)
                );
            }
            catch (SocketException error) when (!acknowledged)
            {
                await WriteError(client, NodeError(error.SocketErrorCode));
            }
            catch (OperationCanceledException) when (!acknowledged)
            {
                await WriteError(client, "ETIMEDOUT");
            }
            catch (Exception) { /* A failed tunnel must not stop the helper. */ }
        }
    }
}
