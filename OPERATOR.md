# Daily 5-minute routine (Admin page: /#admin)
1. **Health (10s):** check that `/healthz` returns `ok:true` and that vision says `xai`, not `mock`.
2. **Review queue (2 min):** select all and approve anything that looks normal. Reject GPS jumps, bursts from one user, and repeats from the same spot. Don't let the queue grow; anything left there earns nothing.
3. **Daily Drop (30s):** check the prize vote and sponsor slot. click "Pick 1 winner" (or leave auto-pick on). Send the prize, such as a $20 gift-card code or a pizza order, to the address in the Outbox email. Note it in a spreadsheet.
4. **Money (30s):** compare Revenue with Paid out and Owed. In cash mode, keep the daily cap at or below what revenue supports. If anything looks wrong, use the **kill switch**.
5. **Pool (10s):** check the pool vs per-scan paid. On the 1st, confirm the bonus ran.
   **Rates:** in Hybrid mode, check that the per-user cap and the global budget still fit revenue.
6. **Fraud stats + 1099 watch (30s):** look for a flag type that's spiking, and for anyone near $600 YTD (make sure Stripe has their W-9).
7. **Buyers + leads (30s):** answer new quote requests the same day. for new paid orders, check that an API key was sent. If not, issue one manually.

Weekly: download a copy from `backups/`. Monthly: rotate `ADMIN_TOKEN` if it was shared.
