import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import styles from "./narrative-section.module.css";

export function NarrativeSection({
  eyebrow,
  title,
  description,
  action,
  href,
  children,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action: string;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <header className={styles.header}>
          <p>{eyebrow}</p>
          <h1>{title}</h1>
          <span>{description}</span>
        </header>
        <section className={styles.stage}>{children}</section>
        <Link href={href} className={styles.action}>
          {action} <HugeiconsIcon icon={ArrowRight01Icon} size={15} />
        </Link>
      </div>
    </div>
  );
}

