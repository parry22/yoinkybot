import { HugeiconsIcon } from "@hugeicons/react";
import { Link01Icon } from "@hugeicons/core-free-icons";
import styles from "./connect-accounts.module.css";

type Account = { handle: string; status: string; post_count: number } | null;

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
            {account.status === "ingested" ? `read · ${account.post_count} posts` : account.status}
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
