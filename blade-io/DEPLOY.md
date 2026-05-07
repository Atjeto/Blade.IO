# Deploying BLADE.IO to Fly.io

You'll have a public URL in about **5 minutes** if you've never used Fly,
**60 seconds** if you have.

## One-time setup (skip if you already have flyctl)

1. Install flyctl:
   ```
   # macOS
   brew install flyctl
   # or curl
   curl -L https://fly.io/install.sh | sh
   ```

2. Sign up / log in:
   ```
   fly auth signup    # first time
   fly auth login     # if returning
   ```
   Free tier covers what we need. You will be asked for a credit card —
   they don't charge for free-tier usage but they want it to deter abuse.

## Deploy

From the project directory:

```
fly launch --copy-config --no-deploy
```

When it prompts:
- **App name**: `blade-io` (or pick something else if taken; the URL becomes `<name>.fly.dev`)
- **Region**: pick one near you — `ord` (Chicago), `iad` (Virginia), `lhr` (London),
  `fra` (Frankfurt), `nrt` (Tokyo), `syd` (Sydney) are good defaults.
  Latency from your players matters — pick a region near most of them.
- **Postgres**: NO
- **Redis**: NO
- **Deploy now**: NO (we want to confirm everything first)

Then:
```
fly deploy
```

Wait ~60-90 seconds for the build & rollout. When it's done:

```
fly open
```

That opens `https://<your-app>.fly.dev/`. Share that URL with friends.

## If you hit "app name already taken"

Edit `fly.toml`:
```
app = "blade-io-yourhandle"
```
Then run `fly launch --copy-config --no-deploy` again.

## Verify it's healthy

```
fly logs           # tail server logs (you'll see joins/leaves here)
fly status         # see machine state
curl https://<your-app>.fly.dev/healthz   # should return "ok"
```

## Custom domain (optional)

1. In your DNS provider, add an A record (or CNAME for subdomains) pointing to your Fly app:
   ```
   fly ips list                    # get the IPs
   ```
2. Tell Fly about it:
   ```
   fly certs add blade.yourdomain.com
   ```
3. Wait a couple minutes for the cert to provision.

## Updating after edits

Make changes locally, run `fly deploy` again. Zero-downtime rollout.

## Costs

For one machine running 24/7 at the size we're using (shared-cpu-1x, 256MB),
you're well inside Fly's free tier. If usage explodes:
- Each extra machine ~$2/month
- Bandwidth: $0.02/GB outbound

This game sends ~3KB per snapshot * 30/sec * 50 players = ~4.5 MB/s peak.
At 50 concurrent players running 24/7 you'd burn ~12 TB/month, which is
~$240. Realistically you won't hit that. If you do, that's a good problem
and we'll add multi-region + room sharding.

## Stopping / cleaning up

```
fly apps destroy blade-io
```
