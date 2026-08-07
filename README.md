<div align="center">

<img alt="Orbital logo" src="/assets/logo.png" width="120"><br>
<b>Orbital: A canvas for AI coding agents.</b>

<img alt="Orbital canvas" src="/assets/screenshot.png">
</div>

## Installation

> [!WARNING]
> Orbital runs [Claude Code](https://claude.com/product/claude-code) under the hood.
> Install and authenticate it first:
>
> ```bash
> npm install -g @anthropic-ai/claude-code
> claude auth login
> ```
>
> The `claude` binary must be on your `PATH`.

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/whosgotch/orbital/main/scripts/install.sh | sh
```

Or grab a build from [Releases](https://github.com/whosgotch/orbital/releases).

The macOS app is unsigned. The `curl` install above launches normally. If you download
the `.dmg` instead, macOS will block it — open **System Settings → Privacy & Security**
and click **Open Anyway**.

## Notes

Very early. Expect bugs.

macOS and Linux only. No Windows build yet.

Bug reports and issues are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## License

Source-available under the [Sustainable Use License](LICENSE): free to use and modify
for your own internal business or personal purposes, no resale or hosting as a service.

