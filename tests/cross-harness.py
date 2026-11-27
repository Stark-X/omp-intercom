"""Exercise the installed OMP and Pi CLIs with a local, scripted model endpoint."""

import argparse
import contextlib
import fcntl
import http.server
import json
import os
import pty
import queue
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import threading
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def wait_for(check, description, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.1)
    raise AssertionError(description)


class Rpc:
    def __init__(self, args, cwd, env):
        self.frames = queue.Queue()
        self.stderr = tempfile.TemporaryFile(mode="w+t")
        self.process = subprocess.Popen(
            args, cwd=cwd, env=env, text=True,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr,
        )
        threading.Thread(target=self.read_frames, daemon=True).start()

    def read_frames(self):
        for line in self.process.stdout:
            try:
                self.frames.put(json.loads(line))
            except ValueError:
                continue
        self.frames.put(None)

    def __enter__(self):
        return self

    def __exit__(self, kind, error, traceback):
        self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        if error is not None:
            self.stderr.seek(0)
            print(self.stderr.read())
        self.stderr.close()

    def call(self, command, **parameters):
        call_id = str(uuid.uuid4())
        self.process.stdin.write(json.dumps({"id": call_id, "type": command, **parameters}) + "\n")
        self.process.stdin.flush()
        while True:
            frame = self.frames.get(timeout=20)
            assert frame is not None, f"{command}: RPC exited ({self.process.poll()})"
            if frame.get("type") == "response" and frame.get("id") == call_id:
                assert frame.get("success"), frame
                return frame.get("data", {})

    def messages(self):
        return self.call("get_messages")["messages"]

    def idle(self):
        return not self.call("get_state")["isStreaming"]

    def result(self, text=None):
        latest_result = None

        def find():
            nonlocal latest_result
            results = [
                message for message in self.messages()
                if message["role"] == "toolResult" and message.get("toolName") == "intercom"
            ]
            if results:
                latest_result = results[-1]
            if text is None:
                return latest_result
            return next((message for message in results if text in json.dumps(message)), None)

        description = "No Intercom tool result" if text is None else f"Tool result did not contain {text!r}"
        try:
            result = wait_for(find, description)
        except AssertionError as error:
            raise AssertionError(f"{error}. Latest Intercom result: {latest_result!r}") from error
        assert not result.get("isError") and not result.get("details", {}).get("error"), result
        wait_for(self.idle, "Tool turn did not finish")
        return result


@contextlib.contextmanager
def terminal(args, cwd, env):
    master, slave = pty.openpty()
    try:
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
        process = subprocess.Popen(args, cwd=cwd, env={**env, "TERM": "xterm-256color"},
                                   stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        slave = None

        def press(keys):
            os.write(master, keys.encode())

        def expect(*parts):
            expected = [part.encode() for part in parts]
            output = bytearray()
            deadline = time.monotonic() + 15
            while not all(part in output for part in expected):
                left = deadline - time.monotonic()
                ready = select.select([master], [], [], left)[0] if left > 0 else []
                assert ready, f"Missing {[part for part in expected if part not in output]} in {output[-5000:]!r}"
                try:
                    data = os.read(master, 65536)
                except OSError as error:
                    raise AssertionError(f"Terminal exited ({process.poll()}): {output[-5000:]!r}") from error
                assert data, f"Terminal exited ({process.poll()}): {output[-5000:]!r}"
                output.extend(data)
            return output.decode(errors="replace")

        try:
            yield press, expect
        finally:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
    finally:
        os.close(master)
        if slave is not None:
            os.close(slave)


class ModelFixture:
    def __init__(self):
        self.actions = {name: queue.Queue() for name in ("omp-smoke", "pi-smoke")}
        self.requests = {name: 0 for name in self.actions}
        fixture = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                model = request["model"]
                arguments = None
                if any(tool["function"]["name"] == "intercom" for tool in request.get("tools", [])):
                    fixture.requests[model] += 1
                    try:
                        arguments = fixture.actions[model].get_nowait()
                    except queue.Empty:
                        pass
                if arguments is not None:
                    delta = {"role": "assistant", "tool_calls": [{
                        "index": 0, "id": f"call_{uuid.uuid4().hex}", "type": "function",
                        "function": {"name": "intercom", "arguments": json.dumps(arguments)},
                    }]}
                    finish = "tool_calls"
                else:
                    final_prompt = json.dumps(request["messages"][-1])
                    answer = "391" if "17 times 23" in final_prompt else "Fixture turn complete."
                    delta, finish = {"role": "assistant", "content": answer}, "stop"
                response = {
                    "id": "chatcmpl-fixture", "object": "chat.completion.chunk", "created": 1,
                    "model": model, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
                }
                body = ("data: " + json.dumps(response) + "\n\ndata: [DONE]\n\n").encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}/v1"

    def __enter__(self):
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()

    def prepare(self, model, **arguments):
        self.actions[model].put(arguments)

    def call(self, rpc, model, **arguments):
        self.prepare(model, **arguments)
        rpc.call("prompt", message="Run the fixture's Intercom tool call.")


def run(pi_extension):
    with tempfile.TemporaryDirectory(prefix="omp-ic-", dir="/tmp") as directory, ModelFixture() as fixture:
        root = Path(directory)
        omp_dir, pi_dir, omp_project, pi_project = (
            root / name for name in ("omp", "pi", "omp-project", "pi-project")
        )
        for folder in (omp_dir, pi_dir, omp_project, pi_project):
            folder.mkdir()
        # Exercise an installed plugin with tsx available and no system Node on OMP's PATH.
        installed_extension = root / "plugins/node_modules/omp-intercom"
        for folder in ("src", "skills"):
            shutil.copytree(ROOT / folder, installed_extension / folder)
        shutil.copyfile(ROOT / "package.json", installed_extension / "package.json")
        (installed_extension / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
        omp_bin = root / "omp-bin"
        omp_bin.mkdir()
        for command in ("omp", "bun"):
            executable = shutil.which(command)
            if executable:
                (omp_bin / command).symlink_to(Path(executable).resolve())
        env = {
            **os.environ,
            "XDG_CONFIG_HOME": str(root / "config"),
            "XDG_DATA_HOME": str(root / "data"),
            "XDG_CACHE_HOME": str(root / "cache"),
            "XDG_STATE_HOME": str(root / "state"),
            "PI_INTERCOM_SCOPE_ID": "omp-intercom-test",
            "PI_INTERCOM_ASK_TIMEOUT_MS": "20000",
            "PI_INTERCOM_LIVENESS_INTERVAL_MS": "1000",
        }
        for category in ("XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"):
            (Path(env[category]) / "omp").mkdir(parents=True)
        (omp_dir / "models.yml").write_text(f"""providers:
  fixture:
    baseUrl: {fixture.url}
    api: openai-completions
    auth: none
    models:
      - id: omp-smoke
        name: OMP smoke model
        contextWindow: 200000
        maxTokens: 1024
""")
        (pi_dir / "models.json").write_text(json.dumps({"providers": {"fixture": {
            "baseUrl": fixture.url, "api": "openai-completions", "apiKey": "local-fixture",
            "models": [{"id": "pi-smoke", "contextWindow": 200000, "maxTokens": 1024}],
        }}}))
        omp_env = dict(env, PI_CODING_AGENT_DIR=str(omp_dir), OMP_INTERCOM_PI_AGENT_DIR=str(pi_dir),
                       OMP_INTERCOM_NAME="omp-smoke", OMP_INTERCOM_STABLE_ID="")
        pi_env = dict(env, PI_CODING_AGENT_DIR=str(pi_dir), PI_INTERCOM_STABLE_ID="pi-smoke")
        broker_pid = pi_dir / "intercom/broker.pid"

        def roster():
            result = subprocess.run(
                ["pi-intercom", "list", "--json"], cwd=pi_project, env=pi_env,
                capture_output=True, text=True, timeout=8,
            )
            if result.returncode:
                return {}
            return {session["id"]: session for session in json.loads(result.stdout)["sessions"]}

        with contextlib.ExitStack() as stack:
            def stop_broker():
                if broker_pid.exists():
                    try:
                        os.kill(int(broker_pid.read_text()), signal.SIGTERM)
                    except (FileNotFoundError, ProcessLookupError):
                        pass

            stack.callback(stop_broker)
            omp = stack.enter_context(Rpc(
                ["omp", "--mode", "rpc", "--no-ui", "--no-session", "--no-extensions", "--offline",
                 "--model", "fixture/omp-smoke", "-e", str(installed_extension)],
                omp_project, dict(omp_env, PATH=str(omp_bin)),
            ))
            state = omp.call("get_state")
            omp_id = state["sessionId"]
            assert any(tool["name"] == "intercom" for tool in state["dumpTools"])
            commands = {entry["name"].lstrip("/") for entry in omp.call("get_available_commands")["commands"]}
            assert {"intercom", "handover", "intercom-id", "intercom-pool", "alias"} <= commands, commands
            wait_for(lambda: omp_id in roster(), "OMP did not start the broker and register")
            first_broker = int(broker_pid.read_text())
            assert not (omp_dir / "intercom/broker.sock").exists()

            pi = stack.enter_context(Rpc(
                ["pi", "--mode", "rpc", "--no-session", "--no-extensions", "--no-mcp",
                 "--model", "fixture/pi-smoke", "-e", str(pi_extension)],
                pi_project, pi_env,
            ))
            pi.call("get_state")
            wait_for(lambda: "pi-smoke" in roster(), "Pi did not join the OMP-started broker")
            assert int(broker_pid.read_text()) == first_broker

            fixture.prepare("omp-smoke", action="status")
            omp.call("prompt", message="/skill:intercom Run the fixture's Intercom status call.")
            omp.result(omp_id)
            assert "A plain `send` will not complete" in json.dumps(omp.messages())
            fixture.call(omp, "omp-smoke", action="list")
            omp.result(str(pi_project))

            fixture.call(omp, "omp-smoke", action="send", to="pi-smoke",
                         message="Quiet outbound to Pi", noWake=True)
            omp.result("Delivered to pi-smoke")
            wait_for(lambda: "Quiet outbound to Pi" in json.dumps(pi.messages()), "Pi missed the OMP send")
            assert fixture.requests["pi-smoke"] == 0

            omp_requests = fixture.requests["omp-smoke"]
            fixture.call(pi, "pi-smoke", action="send", to=omp_id, message="Quiet inbound to OMP", noWake=True)
            pi.result()
            wait_for(lambda: "Quiet inbound to OMP" in json.dumps(omp.messages()), "OMP missed the Pi send")
            assert fixture.requests["omp-smoke"] == omp_requests

            fixture.prepare("pi-smoke", action="reply", message="Pi answered the OMP ask")
            fixture.call(omp, "omp-smoke", action="ask", to="pi-smoke", message="Wake Pi and ask")
            omp.result("Pi answered the OMP ask")
            wait_for(pi.idle, "Pi reply turn did not finish")

            fixture.prepare("omp-smoke", action="reply", message="OMP answered the Pi ask")
            fixture.call(pi, "pi-smoke", action="ask", to=omp_id, message="Wake OMP and ask")
            pi.result("OMP answered the Pi ask")
            wait_for(omp.idle, "OMP reply turn did not finish")

            omp.call("new_session")
            replacement_id = omp.call("get_state")["sessionId"]
            assert replacement_id != omp_id
            wait_for(lambda: {replacement_id, "pi-smoke"} <= roster().keys(), "OMP did not register the new session")
            assert omp_id not in roster()

            stop_broker()
            wait_for(lambda: broker_pid.exists() and int(broker_pid.read_text()) != first_broker,
                     "The broker did not restart")
            wait_for(lambda: {replacement_id, "pi-smoke"} <= roster().keys(),
                     "The sessions did not reconnect to the restarted broker")

            second_dir, second_project = root / "omp-second", root / "omp-second-project"
            second_dir.mkdir()
            second_project.mkdir()
            (second_dir / "models.yml").write_text((omp_dir / "models.yml").read_text())
            (second_dir / "config.yml").write_text(f"extensions:\n  - {json.dumps(str(ROOT))}\n")
            second = stack.enter_context(Rpc(
                ["omp", "--mode", "rpc", "--no-ui", "--no-session", "--offline", "--model", "fixture/omp-smoke"],
                second_project, dict(omp_env, PI_CODING_AGENT_DIR=str(second_dir), OMP_INTERCOM_NAME="omp-second"),
            ))
            second_id = second.call("get_state")["sessionId"]
            wait_for(lambda: second_id in roster(), "Second OMP session did not join the broker")
            fixture.call(omp, "omp-smoke", action="send", to="omp-second",
                         message="OMP-to-OMP message", noWake=True)
            omp.result("Delivered to omp-second")
            wait_for(lambda: "OMP-to-OMP message" in json.dumps(second.messages()),
                     "Second OMP session did not receive the message")

            ui_args = ["omp", "--no-session", "--no-extensions", "--offline", "--model", "fixture/omp-smoke", "-e", str(installed_extension)]
            for index, (shortcut, label) in enumerate((("\t", "的消息"), ("\x1b[Z", "下一步任务（可选）"))):
                peer_name = f"omp-zh-{index}"
                ui_env = dict(omp_env, OMP_SKIP_SETUP="1", OMP_INTERCOM_LOCALE="zh-CN",
                              OMP_INTERCOM_NAME=peer_name, OMP_INTERCOM_STABLE_ID=peer_name)
                with terminal(ui_args, omp_project, ui_env) as (press, expect):
                    expect("\x1b[?2004h")
                    wait_for(lambda: peer_name in roster(), "Localized OMP did not join the shared broker")
                    press("/intercom\r")
                    expect(f"Intercom · {peer_name}", "会话池 omp-intercom-test", "写消息")
                    press(shortcut)
                    expect(label)

            print("OMP and Pi passed shared broker, list/status, OMP-to-OMP delivery, bidirectional send and ask/reply, "
                  "no-wake, idle wake, session switching, broker reconnect, and localized native keyboard shortcuts.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pi_extension", type=Path, help="Path to the installed pi-intercom v0.19.0 index.ts")
    run(parser.parse_args().pi_extension.resolve())
