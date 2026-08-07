import { CreateWorkspaceForm } from "@/components/create-workspace-form";
import styles from "@/components/panel.module.css";

export default function NewWorkspacePage() {
  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <div className={styles.head}>
          <div>
            <h1 className={styles.title}>Create a company workspace</h1>
            <p className={styles.subtitle}>Keep company knowledge, experts, claims and publishing governed in one place.</p>
          </div>
        </div>
        <section className={styles.section}>
          <CreateWorkspaceForm />
        </section>
      </div>
    </div>
  );
}

