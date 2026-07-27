import { HugeiconsIcon } from "@hugeicons/react";
import { Link01Icon } from "@hugeicons/core-free-icons";
import styles from "./connect-accounts.module.css";

type Account = { handle: string; status: string } | null;

/* How far the account has got, in words. The pill used to read "read · 82 posts";
 * the corpus size is an implementation detail — it invites the user to judge
 * whether 82 is enough instead of just telling them the account is ready. */
const STATUS_LABEL: Record<string, string> = {
  ingested: "connected",
  ingesting: "reading your posts…",
  pending: "starting…",
  failed: "couldn't read this account",
};

/** X connection status + a reconnect link (goes through the web X OAuth). */
export function XConnectRow({ account }: { account: Account }) {
  return (
    <div>
      {account && (
        <div className={styles.account}>
          <div className={styles.accountLeft}>
            <div className={styles.accountHandle}>{account.handle}</div>
            <div className={styles.accountPlatform}>X</div>
          </div>
          <span className={`${styles.statusPill} ${account.status === "ingested" ? styles.statusIngested : ""}`}>
            {STATUS_LABEL[account.status] ?? account.status}
          </span>
        </div>
      )}

      <div className={styles.connectRow}>
        <a href="/api/auth/x/start" className="btnGhost">
          <HugeiconsIcon icon={Link01Icon} size={14} strokeWidth={1.8} />
          {account ? "Reconnect X" : "Connect X"}
        </a>
      </div>
    </div>
  );
}
