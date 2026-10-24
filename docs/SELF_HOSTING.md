# Self-hosting open-weight models — evaluation

**Recommendation: don't self-host at launch.** Revisit when sustained volume justifies always-on GPUs.

## Break-even

The cheapest routed API today is LTX-2.3 Fast at **$0.03/s (720p) – $0.06/s (1080p)** with audio included. A rented H100-class GPU costs roughly $2–3/hour, i.e. $0.0006–0.0008 per GPU-second. An open model that needs ~60–120 GPU-seconds per output second at 720p comes to ~$0.04–0.10/s **at 100% utilisation**, before engineering, storage, queueing and idle time. In practice utilisation of 30–50% makes self-hosting **more expensive** than the APIs until volume is high and steady.

Re-run this with measured numbers: GPU price, seconds of compute per output second, and real utilisation from the Admin cost dashboard.

## How it would plug in

- Deploy the model behind an HTTP endpoint (or a Replicate deployment / fal private app).
- Add a catalog entry with `provider: 'replicate'` (or a new adapter implementing `VideoProvider`), documented capabilities, a **measured** per-second cost and `pricingConfidence: 'verified'`.
- The router then treats it like any other model: chosen only when it meets the quality bar at the lowest expected cost.
- Only use weights whose licence permits commercial use.
