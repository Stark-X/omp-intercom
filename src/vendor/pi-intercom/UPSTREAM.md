# pi-intercom v0.19.0

Source commit [918f9735e823354ade0476bf952c11cab8d8125d](https://github.com/nicobailon/pi-intercom/tree/918f9735e823354ade0476bf952c11cab8d8125d).

The vendored files provide the shared broker, wire protocol, client, launcher, configuration parser, and reply tracker. The broker's internal dependencies are included so a Pi session can use a broker started by OMP.

- `broker/client.ts` accepts a runtime environment and can check cancellation before writing an outbound message.
- `broker/spawn.ts` accepts the same environment and derives the lock, PID file, health probes, and child process settings from it.
- `broker/broker.ts` starts its idle shutdown timer at startup so a session that closes before registering cannot leave an idle broker behind.
- `config.ts` accepts an explicit configuration file path.
- `reply-tracker.ts` points callers to the adapter's `status` action.

See [LICENSE](LICENSE) for the original copyright and MIT license.
