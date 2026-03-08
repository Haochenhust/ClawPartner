# Restart NanoClaw Service

Restart the NanoClaw background service via launchd.

## Trigger

Use when the user says "restart", "重启服务", "restart nanoclaw", "重启", or `/restart`.

## Steps

1. Run the restart command:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

This requires `required_permissions: ["all"]` to execute outside the sandbox.

2. Wait 3 seconds, then verify the service came back up by checking the last few lines of the log:

```bash
tail -5 ~/Desktop/ClawPartner/logs/nanoclaw.log
```

3. Report back: confirm the service restarted successfully (look for "NanoClaw running" in the log), or surface any error.
