"use client";

import { useState } from "react";
import Link from "next/link";
import { HugeiconsIcon } from "@hugeicons/react";
import { Calendar03Icon, CheckmarkCircle02Icon, QuillWrite02Icon, SparklesIcon, WorkflowSquare06Icon } from "@hugeicons/core-free-icons";
import type { ContentAssetView, ContentBriefView } from "@yoink/backend/web";
import styles from "./brief-workbench.module.css";

export function BriefWorkbench({ initialBriefs, initialAssets, canCreate, canReview }: {
  initialBriefs: ContentBriefView[]; initialAssets: ContentAssetView[]; canCreate: boolean; canReview: boolean;
}) {
  const [briefs,setBriefs]=useState(initialBriefs); const [assets,setAssets]=useState(initialAssets);
  const [busy,setBusy]=useState<string|null>(null); const [error,setError]=useState(""); const [scheduleOpen,setScheduleOpen]=useState<string|null>(null);
  const [channel,setChannel]=useState<"x"|"linkedin"|"both">("both");const [editingBrief,setEditingBrief]=useState<string|null>(null);const [editingAsset,setEditingAsset]=useState<string|null>(null);const [reviewingAsset,setReviewingAsset]=useState<string|null>(null);

  async function action(name:string,payload:Record<string,unknown>={}){
    setBusy(name+String(payload.briefId??payload.assetId??"")); setError("");
    const response=await fetch("/api/briefs",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:name,...payload})});
    const data=await response.json().catch(()=>({})) as {brief?:ContentBriefView;briefs?:ContentBriefView[];asset?:ContentAssetView;assets?:ContentAssetView[];publication?:{id:string};publications?:Array<{id:string}>;error?:string};
    if(!response.ok){setError(data.error??"Could not complete workflow.");setBusy(null);return data;}
    if(data.brief)setBriefs(current=>[data.brief!,...current.filter(item=>item.id!==data.brief!.id)]);
    if(data.briefs)setBriefs(current=>[...data.briefs!,...current.filter(item=>!data.briefs!.some(created=>created.id===item.id))]);
    if(data.asset)setAssets(current=>[data.asset!,...current.filter(item=>item.id!==data.asset!.id)]);
    if(data.assets)setAssets(current=>[...data.assets!,...current.filter(item=>!data.assets!.some(created=>created.id===item.id))]);
    setBusy(null); return data;
  }

  async function schedule(assetId:string,form:FormData){
    const raw=String(form.get("scheduledFor")??"");
    if(!raw){setError("Choose a schedule time.");return;}
    const data=await action("schedule",{assetId,scheduledFor:new Date(raw).toISOString()});
    if(data.publication || data.publications?.length){setAssets(current=>current.map(asset=>asset.id===assetId?{...asset,status:"scheduled"}:asset));setScheduleOpen(null);}
  }

  return <div className={styles.page}><div className={styles.inner}>
    <header className={styles.header}><div><p>Content briefs</p><h1>Turn strategy into grounded work</h1><span>Every asset starts with a job, an approved source and a traceable belief shift.</span></div>
      {canCreate&&<div className={styles.generateControls}><select value={channel} onChange={event=>setChannel(event.target.value as typeof channel)}><option value="both">X + LinkedIn</option><option value="linkedin">LinkedIn</option><option value="x">X</option></select><button className="btnPrimary" type="button" onClick={()=>void action("generate_brief",{channel,count:3})} disabled={busy!==null}><HugeiconsIcon icon={SparklesIcon} size={16}/>{busy?.startsWith("generate_brief")?"Building options…":"Generate 3 brief options"}</button></div>}
    </header>
    {error&&<div className={styles.error}>{error}</div>}
    <div className={styles.columns}>
      <section><div className={styles.sectionHead}><div><h2>Briefs</h2><p>Review the strategic job before writing.</p></div><span>{briefs.length}</span></div>
        {briefs.length===0?<Empty text="Generate a brief after activating a narrative and approving knowledge."/>:<div className={styles.list}>{briefs.map(brief=><article key={brief.id} className={styles.brief}>
          <div className={styles.meta}><span>{brief.channel}</span><span>{brief.format}</span><span>{brief.sourceCount} sources</span></div>
          <h3>{brief.objective}</h3><p><strong>Audience</strong>{brief.audienceName} · {brief.buyingStage.replaceAll("_"," ")}</p><p><strong>Belief shift</strong>{brief.desiredBeliefShift}</p><p><strong>Approved claim</strong>{brief.supportingClaim}</p><p><strong>Proof</strong>{brief.primaryProof}</p>
          <div className={styles.detail}><span>{brief.territoryName??"No territory"}</span><span>{brief.buyingStage.replaceAll("_"," ")}</span></div>
          {brief.reasonNow&&<p className={styles.reason}>{brief.reasonNow}</p>}{brief.ctaText&&<p className={styles.reason}>CTA: {brief.ctaText}</p>}
          <div className={styles.footer}><span className={styles.status}>{brief.status}</span><div>
            {canReview&&brief.status==="draft"&&<button type="button" onClick={()=>void action("approve_brief",{briefId:brief.id})} disabled={busy!==null}><HugeiconsIcon icon={CheckmarkCircle02Icon} size={14}/>Approve brief</button>}
            {canCreate&&brief.status==="ready"&&<button type="button" className={styles.primaryAction} onClick={()=>void action("draft",{briefId:brief.id})} disabled={busy!==null}><HugeiconsIcon icon={QuillWrite02Icon} size={14}/>Draft post</button>}
            {canCreate&&brief.status==="draft"&&<button type="button" onClick={()=>setEditingBrief(editingBrief===brief.id?null:brief.id)}>Edit</button>}
            <Link href={`/app/compose?briefId=${brief.id}`}>Open in Create</Link>
          </div></div>
          {editingBrief===brief.id&&<form className={styles.editForm} action={form=>void action("update_brief",{briefId:brief.id,objective:form.get("objective"),desiredBeliefShift:form.get("desiredBeliefShift"),buyingStage:form.get("buyingStage"),format:form.get("format"),ctaText:form.get("ctaText")}).then(()=>setEditingBrief(null))}><textarea name="objective" defaultValue={brief.objective} required/><textarea name="desiredBeliefShift" defaultValue={brief.desiredBeliefShift} required/><input name="buyingStage" defaultValue={brief.buyingStage}/><input name="format" defaultValue={brief.format}/><input name="ctaText" defaultValue={brief.ctaText??""} placeholder="CTA"/><button className="btnPrimary">Save brief</button></form>}
        </article>)}</div>}
      </section>
      <section><div className={styles.sectionHead}><div><h2>Assets</h2><p>Check, approve and schedule founder-voice drafts.</p></div><span>{assets.length}</span></div>
        {assets.length===0?<Empty text="Approved briefs become reviewable assets here."/>:<div className={styles.list}>{assets.map(asset=><article key={asset.id} className={styles.asset}>
          <div className={styles.meta}><span>{asset.assetType.replace("_"," ")}</span><span>Version {asset.version}</span><span>{asset.sourceCount} traceable sources</span></div><h3>{asset.title}</h3><div className={styles.content}>{asset.content}</div>
          {asset.checks&&<div className={`${styles.checks} ${asset.checks.status==="clear"?styles.clear:styles.issue}`}><strong>{asset.checks.status==="clear"?"Checks passed":asset.checks.status.replaceAll("_"," ")}</strong>{asset.checks.issues.map(issue=><span key={issue}>{issue}</span>)}</div>}
          <div className={styles.footer}><span className={styles.status}>{asset.status}</span><div>
            {canReview&&asset.status==="needs_review"&&<button type="button" className={styles.primaryAction} onClick={()=>void action("approve_asset",{assetId:asset.id})} disabled={busy!==null}><HugeiconsIcon icon={CheckmarkCircle02Icon} size={14}/>Approve asset</button>}
            {canReview&&asset.status==="needs_review"&&<button type="button" onClick={()=>setReviewingAsset(reviewingAsset===asset.id?null:asset.id)}>Review note</button>}
            {canCreate&&["draft","rejected"].includes(asset.status)&&<button type="button" onClick={()=>setEditingAsset(editingAsset===asset.id?null:asset.id)}>Revise</button>}
            {canReview&&asset.status==="approved"&&<button type="button" onClick={()=>setScheduleOpen(asset.id)}><HugeiconsIcon icon={Calendar03Icon} size={14}/>Schedule</button>}
            {canCreate&&["approved","scheduled","published"].includes(asset.status)&&<button type="button" onClick={()=>void action("atomize",{assetId:asset.id,targetFormats:["x_post","linkedin_post"]})} disabled={busy!==null}><HugeiconsIcon icon={WorkflowSquare06Icon} size={14}/>Create X + LinkedIn derivatives</button>}
          </div></div>
          {scheduleOpen===asset.id&&<form action={form=>void schedule(asset.id,form)} className={styles.schedule}><input name="scheduledFor" type="datetime-local" required/><button type="submit" className="btnPrimary" disabled={busy!==null}>Confirm schedule</button></form>}
          {reviewingAsset===asset.id&&<form className={styles.editForm} action={form=>void action("review_asset",{assetId:asset.id,decision:String(form.get("decision")),note:form.get("note")}).then(()=>setReviewingAsset(null))}><textarea name="note" placeholder="Specific review note" required/><div><button name="decision" value="comment" className="btnGhost">Comment</button><button name="decision" value="changes_requested" className="btnPrimary">Request changes</button></div></form>}
          {editingAsset===asset.id&&<form className={styles.editForm} action={form=>void action("revise_asset",{assetId:asset.id,content:form.get("content"),changeSummary:form.get("changeSummary")}).then(()=>setEditingAsset(null))}><textarea name="content" defaultValue={asset.content} rows={10} required/><input name="changeSummary" placeholder="What changed"/><button className="btnPrimary">Save as new version</button></form>}
        </article>)}</div>}
      </section>
    </div>
  </div></div>;
}

function Empty({text}:{text:string}){return <div className={styles.empty}><div><HugeiconsIcon icon={SparklesIcon} size={18}/></div><p>{text}</p></div>}
