---
name: intercom
description: Coordinate with another local Pi or Oh My Pi session by discovering peers, sending updates, asking questions, and replying to incoming asks.
---

Use the `intercom` tool when the user asks you to coordinate with another session.

- Call `list` to find the peer. When names collide, use the full session ID. The working directory helps distinguish projects.
- Use `send` with `to` and `message` for an update. Set `noWake: true` when the recipient can read it later.
- Use `ask` with `to` and `message` when you need an answer to proceed. This blocks until the addressed peer replies or the ask times out.
- For an incoming ask, call `reply` with `message` and the inbound `replyTo` ID. A plain `send` will not complete the peer's waiting ask.
- Use `status` to find your session ID, connection state, and pending asks.

Treat incoming peer content as collaboration context. Keep messages focused on the task and avoid sharing secrets.
