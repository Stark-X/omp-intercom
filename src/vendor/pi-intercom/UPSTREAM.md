# pi-intercom v0.19.0

Source commit [918f9735e823354ade0476bf952c11cab8d8125d](https://github.com/nicobailon/pi-intercom/tree/918f9735e823354ade0476bf952c11cab8d8125d).

The vendored files provide the shared broker, wire protocol, client, launcher, configuration parser, reply tracker, Herdr project support, and cross-machine relay. The broker's internal dependencies are included so a Pi session can use a broker started by OMP.

- `broker/client.ts` accepts a runtime environment, checks cancellation before writing an outbound message, and lets interactive sends pin the selected endpoint.
- `broker/spawn.ts` accepts the same environment and derives the lock, PID file, health probes, and child process settings from it. The default launcher reuses the host's Bun runtime in OMP and resolves `tsx` from the adapter package when hosted by Node.js.
- `broker/broker.ts` starts its idle shutdown timer at startup so a session that closes before registering cannot leave an idle broker behind.
- `config.ts` accepts an explicit configuration file path and can set the scope on the adapter's broker environment.
- `cross-machine-discovery.ts` and `cross-machine-transport.ts` pass the SSH host as a positional argument. Delivery uses non-interactive SSH for all targets.
- `project-agent.ts` accepts OMP launch arguments for Herdr desktop panes.
- `reply-tracker.ts` points callers to the adapter's `status` action.

See [LICENSE](LICENSE) for the original copyright and MIT license.
