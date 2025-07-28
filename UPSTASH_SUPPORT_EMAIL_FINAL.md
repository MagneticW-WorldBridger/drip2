Dear Upstash Support,

I hope you're well. We're reaching out for your help investigating a Redis issue that occurred on July 18th around 15:35 UTC, involving the database:

hopeful-chigger-32139.upstash.io:6379

⸻

What happened

We rely on Redis streams to manage message timing for marketing automation, with strict delay logic to enforce business hour restrictions (8 AM – 8 PM local time) due to legal/compliance obligations.

During the event, messages that were scheduled for future delivery were executed immediately, bypassing our queuing logic entirely.

Initial analysis suggests the cause may be related to rate limiting, as we noticed:
	•	evicted_clients: 41
	•	Ops/sec briefly exceeded the 10,000 threshold
	•	Redis stream backlog grew to 130+ messages
	•	The system recovered once limits relaxed

⸻

Why this matters

Some of our clients are in regulated industries (e.g. healthcare, finance). Violating business hour rules can result in:
	•	Regulatory issues (TCPA, CAN-SPAM)
	•	Potential fines or legal exposure
	•	Loss of trust in automation timing

⸻

What we need

We'd appreciate your guidance on a few key points:
	1.	Can you confirm if rate limiting occurred around that time?
	2.	What's the best way to monitor or avoid silent failures due to limits?
	3.	Is there an upgrade path or best practice you'd recommend for our usage?

⸻

Thank you very much for your support — we really value the platform and want to ensure this doesn't happen again.

Best regards,
Jean Delasse
Technical Lead, LeadsByAI
jean@getpromark.com
+1 (XXX) XXX-XXXX

⸻ 