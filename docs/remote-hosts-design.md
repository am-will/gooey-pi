# Remote hosts design

This is a proposal for [issue #160](https://github.com/am-will/gooey-pi/issues/160). GooeyPi currently runs harnesses and workspace tools on the local computer. This document does not add an SSH connection or a remote execution service.

## Keep a workspace on one host

A remote workspace needs more than an SSH terminal. Its harness, files, Git repository, terminals, schedules, and browser resources need one execution host. Running some of those locally would show the wrong files or apply changes to a different checkout.

Introduce an execution-host identifier on workspace ownership before adding connection controls. A workspace reference contains a host identifier and a path meaningful on that host. A remote path must never pass through local path authorization or local shell execution.

The existing main-process services provide the useful boundaries: project authorization, session catalogs, agent RPC, Git, terminal processes, schedules, and browser guests. Keep their operations behind a host-specific service boundary. Do not concatenate SSH commands at individual UI call sites.

## Start with an explicit connection

The first version can use the user's existing SSH client and configuration. The user selects a configured host and grants a specific remote project directory. Resolve SSH options through that client rather than duplicating private-key handling in GooeyPi. Preserve host-key verification. A changed or unknown host identity requires the user's normal SSH trust decision.

Do not copy credentials, local provider keys, browser cookies, or local schedules to the host. The remote harness uses credentials already configured on that host. The UI needs to state which host owns each project and running session.

A small remote helper would expose framed, versioned operations over the authenticated SSH channel. Negotiate its protocol before sending requests. Validate incoming messages with explicit size and concurrency limits, as the local RPC transport does. Authorize filesystem operations against granted remote roots after resolving remote symlinks.

The helper's installation, update policy, supported operating systems, and process lifetime need approval before implementation. An SSH login alone is not permission to install a persistent service.

## Treat a disconnect as an uncertain state

Use connection states that distinguish disconnected, connecting, connected, and reconnecting. Report the last observed runtime state separately from the connection state. A dropped network connection does not prove that an agent stopped.

On reconnect, reconcile sessions and running processes with the host before accepting new work. Give mutations request identifiers so retrying an acknowledged request cannot duplicate a prompt, start a second terminal, or run a schedule twice. Persist the remote result before acknowledging operations that must survive reconnects.

Keep cancellation explicit. Closing a panel releases its observation subscription. Stopping a remote process sends a separate cancellation request and reports whether the host acknowledged it.

## Limit the first release

Start with remote project selection, harness discovery, chat, file browsing, Git status, and terminals. Keep schedules disabled until ownership and recovery work when the desktop disconnects. Keep browser control and computer use disabled until their permissions and display location are defined.

Do not silently forward local browser guests into a remote session. The capability panel must describe which features run on the remote host and which are unavailable.

## Verify the host boundary

Before shipping, verify these cases against a disposable SSH host:

- A remote path cannot invoke a local filesystem or Git operation.
- A changed host key fails closed.
- A symlink outside the remote project grant is rejected.
- Disconnecting during prompt delivery cannot produce a duplicate turn on reconnect.
- Reconnecting recovers the actual agent state without marking an unknown state idle.
- Terminal resize, exit, cancellation, and reconnect do not leak remote processes.
- Removing a host revokes its project grants and observation subscriptions.
- Version mismatch fails before a mutation runs.

## Decisions before implementation

Choose the initial remote operating systems, helper distribution method, reconnect retention period, and whether agents keep running after the desktop exits. Decide whether local and remote projects share one sidebar group or have a visible host grouping. Those choices affect ownership and user expectations, so they should be reviewed with a working prototype.
