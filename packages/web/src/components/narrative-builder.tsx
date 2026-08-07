"use client";

import { FormEvent, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { CheckmarkCircle02Icon, SparklesIcon } from "@hugeicons/core-free-icons";
import type { ClaimRegistryView, NarrativeArchitectureView, NarrativeSystemView } from "@yoink/backend/web";
import styles from "./narrative-builder.module.css";

export function NarrativeBuilder({
  initialSystems,
  initialArchitecture,
  proofOptions,
  canBuild,
  canReviewClaims,
  canReviewHighRisk,
}: {
  initialSystems: NarrativeSystemView[];
  initialArchitecture:NarrativeArchitectureView;
  proofOptions:Array<{id:string;title:string}>;
  canBuild: boolean;
  canReviewClaims:boolean;
  canReviewHighRisk:boolean;
}) {
  const [systems, setSystems] = useState(initialSystems);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [architecture,setArchitecture]=useState(initialArchitecture);
  const draft = systems.find((system) => system.status === "draft") ?? null;
  const active = systems.find((system) => system.status === "active") ?? null;

  async function generate() {
    setBusy(true);
    setError("");
    const response = await fetch("/api/narrative", { method: "POST" });
    const data = (await response.json().catch(() => ({}))) as { narrative?: NarrativeSystemView; error?: string };
    if (response.ok && data.narrative) setSystems((current) => [data.narrative!, ...current.filter((item) => item.status !== "draft")]);
    else setError(data.error ?? "Could not build narrative.");
    setBusy(false);
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft) return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const activate = submitter?.value === "activate";
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/narrative", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        narrativeId: draft.id,
        categoryThesis: form.get("categoryThesis"),
        problemNarrative: form.get("problemNarrative"),
        pointOfView: form.get("pointOfView"),
        uniqueMechanism: form.get("uniqueMechanism"),
        primaryPromise: form.get("primaryPromise"),
        activate,
      }),
    });
    const data = (await response.json().catch(() => ({}))) as { narrative?: NarrativeSystemView; error?: string };
    if (response.ok && data.narrative) {
      setSystems((current) => current.map((item) => {
        if (item.id === data.narrative!.id) return data.narrative!;
        if (activate && item.status === "active") return { ...item, status: "superseded" };
        return item;
      }));
    } else setError(data.error ?? "Could not save narrative.");
    setBusy(false);
  }

  async function createAudience(event:FormEvent<HTMLFormElement>){event.preventDefault();setBusy(true);setError("");const form=new FormData(event.currentTarget);const response=await fetch("/api/narrative",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"create_audience",name:form.get("name"),roleType:form.get("roleType"),description:form.get("description"),needs:String(form.get("needs")??"").split("\n").map(item=>item.trim()).filter(Boolean),objections:String(form.get("objections")??"").split("\n").map(item=>item.trim()).filter(Boolean),successDefinition:form.get("successDefinition")})});const data=await response.json().catch(()=>({})) as {audience?:NarrativeArchitectureView["audiences"][number];error?:string};if(response.ok&&data.audience){setArchitecture(current=>({...current,audiences:[...current.audiences,data.audience!]}));event.currentTarget.reset();}else setError(data.error??"Could not save audience.");setBusy(false);}

  async function createQuestion(event:FormEvent<HTMLFormElement>){event.preventDefault();setBusy(true);setError("");const form=new FormData(event.currentTarget);const response=await fetch("/api/narrative",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"create_journey_question",audienceId:form.get("audienceId"),stage:form.get("stage"),question:form.get("question"),priority:50})});const data=await response.json().catch(()=>({})) as {question?:NarrativeArchitectureView["journeyQuestions"][number];error?:string};if(response.ok&&data.question){setArchitecture(current=>({...current,journeyQuestions:[...current.journeyQuestions,data.question!]}));event.currentTarget.reset();}else setError(data.error??"Could not save buyer question.");setBusy(false);}

  async function reviewClaim(event:FormEvent<HTMLFormElement>,claim:ClaimRegistryView){event.preventDefault();setBusy(true);setError("");const form=new FormData(event.currentTarget);const decision=String((event.nativeEvent as SubmitEvent).submitter instanceof HTMLButtonElement?((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement).value:"approved");const response=await fetch("/api/narrative",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({action:"review_claim",claimId:claim.id,decision,riskLevel:form.get("riskLevel"),evidenceRequirements:form.get("evidenceRequirements"),evidenceObjectIds:form.getAll("evidenceObjectIds"),allowedContexts:String(form.get("allowedContexts")??"").split(",").map(item=>item.trim()).filter(Boolean),prohibitedContexts:form.getAll("prohibitedContexts")})});const data=await response.json().catch(()=>({})) as {claim?:ClaimRegistryView;error?:string};if(response.ok&&data.claim)setArchitecture(current=>({...current,claims:current.claims.map(item=>item.id===data.claim!.id?data.claim!:item)}));else setError(data.error??"Could not review claim.");setBusy(false);}

  return (
    <div className={styles.page}>
      <div className={styles.inner}>
        <header className={styles.header}>
          <div><p>Narrative architecture</p><h1>What should the company become known for?</h1><span>Build from approved knowledge, edit the proposal, then deliberately activate a version.</span></div>
          {active && <div className={styles.activeBadge}><HugeiconsIcon icon={CheckmarkCircle02Icon} size={15} /> Version {active.version} active</div>}
        </header>
        {error && <div className={styles.error}>{error}</div>}

        {!draft ? (
          <section className={styles.startCard}>
            <div className={styles.spark}><HugeiconsIcon icon={SparklesIcon} size={22} /></div>
            <h2>{active ? "Create the next narrative version" : "Build your first narrative system"}</h2>
            <p>Yoinky will use only approved workspace knowledge to propose a category thesis, problem narrative, point of view, mechanism, promise and editorial territories.</p>
            {canBuild ? <button type="button" className="btnPrimary" onClick={() => void generate()} disabled={busy}>{busy ? "Building…" : "Generate proposal"}</button> : <span className={styles.roleNote}>A strategist or workspace owner can build the narrative.</span>}
          </section>
        ) : (
          <form className={styles.builder} onSubmit={(event) => void save(event)}>
            <div className={styles.builderTop}>
              <div><span>Draft version {draft.version}</span><h2>Edit the proposed system</h2></div>
              <span className={styles.draftPill}>Not active</span>
            </div>
            <NarrativeField name="categoryThesis" label="Category thesis" defaultValue={draft.categoryThesis} />
            <NarrativeField name="problemNarrative" label="Problem narrative" defaultValue={draft.problemNarrative} />
            <NarrativeField name="pointOfView" label="Company point of view" defaultValue={draft.pointOfView} />
            <NarrativeField name="uniqueMechanism" label="Unique mechanism" defaultValue={draft.uniqueMechanism} />
            <NarrativeField name="primaryPromise" label="Primary promise" defaultValue={draft.primaryPromise} />
            <div className={styles.territories}>
              <h3>Editorial territories</h3>
              {draft.territories.map((territory) => (
                <article key={territory.id}><strong>{territory.name}</strong><p>{territory.companyPerspective}</p><span>Proof needed: {territory.proofRequirements || "Review per brief"}</span></article>
              ))}
            </div>
            <div className={styles.actions}>
              <button type="submit" name="action" value="save" className="btnGhost" disabled={busy}>Save draft</button>
              <button type="submit" name="action" value="activate" className="btnPrimary" disabled={busy}>Activate narrative</button>
            </div>
          </form>
        )}

        {active && (
          <section className={styles.activeSummary}>
            <div><span>Active narrative, version {active.version}</span><h2>{active.categoryThesis}</h2><p>{active.pointOfView}</p></div>
            <div className={styles.activeFacts}><div><span>Mechanism</span><p>{active.uniqueMechanism}</p></div><div><span>Promise</span><p>{active.primaryPromise}</p></div></div>
          </section>
        )}

        <section className={styles.architectureGrid}>
          <div className={styles.architecturePanel}>
            <div className={styles.panelHead}><div><span>Audiences</span><h2>Who needs to believe what?</h2></div><b>{architecture.audiences.length}</b></div>
            {architecture.audiences.map(audience=><article className={styles.architectureItem} key={audience.id}><strong>{audience.name}</strong><span>{audience.roleType.replaceAll("_"," ")}</span>{audience.description&&<p>{audience.description}</p>}</article>)}
            {canBuild&&<form className={styles.compactForm} onSubmit={event=>void createAudience(event)}><input name="name" placeholder="Audience name" required/><select name="roleType" defaultValue="champion"><option value="end_user">End user</option><option value="champion">Champion</option><option value="technical_evaluator">Technical evaluator</option><option value="budget_owner">Budget owner</option><option value="executive_approver">Executive approver</option><option value="influencer">Influencer</option></select><textarea name="description" placeholder="What they are trying to accomplish" rows={2}/><textarea name="needs" placeholder="Needs, one per line" rows={2}/><textarea name="objections" placeholder="Objections, one per line" rows={2}/><input name="successDefinition" placeholder="What success means to them"/><button className="btnGhost" disabled={busy}>Add audience</button></form>}
          </div>
          <div className={styles.architecturePanel}>
            <div className={styles.panelHead}><div><span>Buyer journey</span><h2>Questions the narrative must answer</h2></div><b>{architecture.journeyQuestions.length}</b></div>
            {architecture.journeyQuestions.map(question=><article className={styles.architectureItem} key={question.id}><strong>{question.question}</strong><span>{question.audienceName??"All audiences"} · {question.stage.replaceAll("_"," ")}</span></article>)}
            {canBuild&&<form className={styles.compactForm} onSubmit={event=>void createQuestion(event)}><select name="audienceId" defaultValue=""><option value="">All audiences</option>{architecture.audiences.map(item=><option value={item.id} key={item.id}>{item.name}</option>)}</select><select name="stage" defaultValue="problem_aware"><option value="problem_unaware">Problem unaware</option><option value="problem_aware">Problem aware</option><option value="solution_aware">Solution aware</option><option value="product_aware">Product aware</option><option value="evaluation">Evaluation</option><option value="purchase">Purchase</option><option value="adoption">Adoption</option><option value="advocacy">Advocacy</option></select><textarea name="question" placeholder="What must this audience understand next?" required rows={2}/><button className="btnGhost" disabled={busy}>Add journey question</button></form>}
          </div>
        </section>

        {architecture.messages.length>0&&<section className={styles.claimRegistry}><div className={styles.panelHead}><div><span>Message architecture</span><h2>Reusable audience and company messages</h2></div><b>{architecture.messages.length}</b></div><div className={styles.messageGrid}>{architecture.messages.map(message=><article className={styles.architectureItem} key={message.id}><strong>{message.newInsight??message.problem??message.messageType}</strong><span>{message.messageType.replaceAll("_"," ")}{message.audienceName?` · ${message.audienceName}`:""}</span>{message.mechanism&&<p>{message.mechanism}</p>}</article>)}</div></section>}

        <section className={styles.claimRegistry}>
          <div className={styles.panelHead}><div><span>Claim registry</span><h2>What the company may and may not say</h2><p>Knowledge approval is not public-use approval. Risk, evidence and channel context are checked again before publication.</p></div><b>{architecture.claims.length}</b></div>
          {architecture.claims.length===0?<div className={styles.emptyLine}>Approved claim objects will enter this registry as pending.</div>:architecture.claims.map(claim=><form key={claim.id} className={styles.claimCard} onSubmit={event=>void reviewClaim(event,claim)}><div className={styles.claimTop}><div><span>{claim.approvalStatus}</span><strong>{claim.claimText}</strong></div><select name="riskLevel" defaultValue={claim.riskLevel} disabled={!canReviewClaims}><option value="low">Low risk</option><option value="medium">Medium risk</option><option value="high">High risk</option><option value="regulated">Regulated</option></select></div><textarea name="evidenceRequirements" defaultValue={claim.evidenceRequirements??""} placeholder="Evidence and qualification requirements" rows={2} disabled={!canReviewClaims}/><div className={styles.claimFields}><label><span>Approved proof</span><select name="evidenceObjectIds" multiple defaultValue={claim.evidenceObjectIds} disabled={!canReviewClaims}>{proofOptions.map(proof=><option value={proof.id} key={proof.id}>{proof.title}</option>)}</select></label><label><span>Allowed contexts</span><input name="allowedContexts" defaultValue={claim.allowedContexts.join(", ")} placeholder="linkedin, x, sales" disabled={!canReviewClaims}/></label><label><span>Prohibited channels</span><select name="prohibitedContexts" multiple defaultValue={claim.prohibitedContexts} disabled={!canReviewClaims}><option value="x">X</option><option value="linkedin">LinkedIn</option></select></label></div>{canReviewClaims&&<div className={styles.claimActions}><button type="submit" value="rejected" className="btnGhost" disabled={busy}>Reject</button><button type="submit" value="prohibited" className="btnGhost" disabled={busy}>Prohibit</button><button type="submit" value="approved" className="btnPrimary" disabled={busy||(["high","regulated"].includes(claim.riskLevel)&&!canReviewHighRisk)}>Approve for public use</button></div>}</form>)}
        </section>
      </div>
    </div>
  );
}

function NarrativeField({ name, label, defaultValue }: { name: string; label: string; defaultValue: string }) {
  return <label className={styles.field}><span>{label}</span><textarea name={name} defaultValue={defaultValue} required minLength={10} rows={3} /></label>;
}
