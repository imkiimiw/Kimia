# Hosting the worker (researched 2026-11-08)

The worker needs: Linux with Docker, ~1 GB RAM per concurrent image job (2 GB+ total is comfortable),
outbound HTTPS to `api.telegram.org`, and an **HTTPS URL the bot can reach** (the bot calls it from
Telegram Serverless). It keeps its queue in SQLite on a persistent disk and works in background
threads after answering the bot — which matters for the choice below.

Both candidates named in the spec need a payment card at sign-up and are run by US companies whose
terms follow US export rules (embargoed countries can't hold accounts). Opening an account is the
owner's decision; nothing here was created or paid for.

## Recommendation: Oracle Cloud "Always Free" Arm VM

From Oracle's Always Free page (checked today):
- **Ampere A1** (`VM.Standard.A1.Flex`, Arm): 1,500 OCPU-hours and 9,000 GB-hours per month free —
  "equivalent to 2 OCPUs and 12 GB of memory", as one VM or two.
- 200 GB block storage (boot + volumes) in the home region; **10 TB outbound per month**.
- Always Free instances must be in the **home region**; "out of host capacity" means retry later or in
  another availability domain.
- **Idle reclamation:** Oracle may reclaim an Always Free VM when, over 7 days, CPU (95th percentile),
  network and (A1) memory all stay under 20 %. A quiet worker can hit that. Upgrading the account to
  Pay As You Go keeps Always Free resources free (Oracle: it charges only above the Always Free
  limits) — the owner's decision, since it attaches a card to billable usage.

Why it fits: an always-on VM with a real disk matches the SQLite queue and background threads; 2
OCPU / 12 GB is far more than C4 needs and leaves room for LibreOffice/FFmpeg/Tesseract (C5–C7).

### Step by step
1. Sign up at <https://www.oracle.com/cloud/free/> (card verification; pick the home region carefully —
   it can't be changed).
2. Create the VM: *Compute → Instances → Create* · Image **Ubuntu 24.04** (aarch64) · Shape
   **VM.Standard.A1.Flex, 2 OCPU, 12 GB** · add your SSH public key · keep "Assign a public IPv4".
3. Open ports 80 and 443: *Networking → VCN → Security List → Add Ingress Rules* (source `0.0.0.0/0`,
   TCP 80 and 443). Ubuntu images on OCI also filter in iptables, so on the VM:
   ```bash
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```
4. A DNS name for the TLS certificate: your own domain (an `A` record to the VM's IP), or a free
   [DuckDNS](https://www.duckdns.org) name.
5. Install Docker and get the worker:
   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER && newgrp docker
   git clone --depth 1 --filter=blob:none --sparse https://github.com/imkiimiw/Kimia.git
   cd Kimia && git sparse-checkout set bots/converter/worker && cd bots/converter/worker
   ```
   (For a private repository, copy the folder instead: `scp -r bots/converter/worker ubuntu@<ip>:`.)
6. Configure and start:
   ```bash
   cp .env.example .env
   python3 -c "import secrets; print(secrets.token_urlsafe(48))"   # → WORKER_SECRET
   nano .env            # BOT_TOKEN, WORKER_SECRET, WORKER_DOMAIN=worker.example.com
   docker compose --profile tls up -d --build
   curl https://worker.example.com/healthz      # {"ok":true}
   ```
7. Connect the bot (private chat with the bot, owner only):
   ```
   /secret set WORKER_URL https://worker.example.com
   /secret set WORKER_SECRET <the same value>
   ```
   `/panel → 🛠 Worker` shows health and tools; the image tools appear for users within 10 minutes.
8. Updates: `git pull && docker compose --profile tls up -d --build`. Logs: `docker compose logs -f worker`.

## Not recommended for this design: Google Cloud Run free tier

Cloud Run's free tier (Tier 1 regions): request-based billing 180,000 vCPU-seconds, 360,000 GiB-seconds
and 2 million requests per month; instance-based billing 240,000 vCPU-seconds and 450,000 GiB-seconds.
With request-based billing the CPU is throttled outside requests, so the worker's background
processing after `202 Accepted` would stall. Instance-based billing with one always-on instance needs
about 2.6 million vCPU-seconds a month — over ten times the free amount — and the container's disk is
ephemeral, so the SQLite queue would be lost on every restart. Using Cloud Run would mean redesigning
the worker (process inside the request, external queue) and still risks charges.

## Also possible: any Linux machine + Cloudflare Tunnel

A home PC, an old laptop or any paid VPS works the same way (`docker compose up -d --build`). Without a
public IP, a Cloudflare Tunnel gives the HTTPS URL: `cloudflared tunnel --url http://localhost:8080`
prints a temporary `https://….trycloudflare.com` address (fine for testing); a permanent named tunnel
needs a domain on a free Cloudflare account. The machine must stay on for the tools to stay available —
when the worker is unreachable the bot hides worker tools again within 10 minutes and tells users who
press an old button that the tool is temporarily unavailable.

Sources: Oracle "Always Free Resources" (docs.oracle.com, Free Tier topic); Google "Cloud Run pricing"
(cloud.google.com/run/pricing).
