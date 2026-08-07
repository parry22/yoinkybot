"use client";

import { useState } from "react";
import type { EditorialReviewView,WorkspaceIntelligenceView } from "@yoink/backend/web";
import styles from "./workspace-intelligence.module.css";

const pct=(n:number|null)=>n===null?"No data":`${Math.round(n)}%`;
const hours=(n:number|null)=>n===null?"No data":n<24?`${n.toFixed(1)}h`:`${(n/24).toFixed(1)}d`;
const rate=(n:number|null)=>n===null?"No baseline":`${(n*100).toFixed(1)}%`;

export function WorkspaceIntelligence({data,canReview}:{data:WorkspaceIntelligenceView;canReview:boolean}){
  const [reviews,setReviews]=useState(data.reviews),[busy,setBusy]=useState(false),[error,setError]=useState("");
  async function generate(form:FormData){setBusy(true);setError("");const response=await fetch("/api/editorial",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({periodStart:String(form.get("periodStart")),periodEnd:String(form.get("periodEnd"))})});const body=await response.json().catch(()=>({})) as {review?:EditorialReviewView;error?:string};setBusy(false);if(!response.ok){setError(body.error??"Could not generate review.");return;}if(body.review)setReviews(current=>[body.review!,...current]);}
  return <section className={styles.wrap}>
    <div className={styles.head}><div><p>Company intelligence</p><h2>What your knowledge is doing in market</h2><span>Operational, narrative and commercial learning with source lineage intact.</span></div>{canReview&&<form className={styles.reviewForm} action={form=>void generate(form)}><input name="periodStart" type="date" required/><input name="periodEnd" type="date" required/><button disabled={busy}>{busy?"Reviewing…":"Generate editorial review"}</button></form>}</div>
    {error&&<div className={styles.error}>{error}</div>}
    <div className={styles.tiles}><Metric label="Assets, last 30 days" value={String(data.production.assetsLast30Days)}/><Metric label="Source utilisation" value={pct(data.production.sourceUtilizationPct)}/><Metric label="Capture to approval" value={hours(data.production.captureToKnowledgeHours)}/><Metric label="Influenced opportunities" value={String(data.commercial.influencedOpportunities)}/></div>
    <div className={styles.grid}>
      <Panel title="Knowledge performance" description="Activation and outcomes by approved knowledge object.">{data.knowledge.length===0?<Empty>No approved knowledge yet.</Empty>:data.knowledge.slice(0,10).map(item=><Row key={item.id} title={item.title} subtitle={`${item.objectType.replaceAll("_"," ")} · ${item.activation}`} metrics={`${item.assetCount} assets\n${item.conversionCount} conversions`}/>)}</Panel>
      <Panel title="Knowledge types" description="Which kinds of internal knowledge create useful activation.">{data.knowledgeTypes.length===0?<Empty>No knowledge evidence yet.</Empty>:data.knowledgeTypes.map(item=><Row key={item.objectType} title={item.objectType.replaceAll("_"," ")} subtitle={`${item.objectCount} approved · ${item.unusedCount} unused`} metrics={`${item.assetCount} assets\n${item.conversionCount} conversions`}/>)}</Panel>
      <Panel title="Territory performance" description="Attention and commercial influence stay separate.">{data.territories.length===0?<Empty>No active territories yet.</Empty>:data.territories.map(item=><Row key={item.id} title={item.name} subtitle={`${item.publicationCount} published`} metrics={`${item.conversionCount} conversions\n${item.influencedValue>0?`${data.commercial.currency??""} ${item.influencedValue}`:"No influenced value"}`}/>)}</Panel>
      <Panel title="Source utilisation" description="Which source streams become activated knowledge.">{data.sources.length===0?<Empty>No workspace sources yet.</Empty>:data.sources.map(item=><Row key={item.id} title={item.name} subtitle={item.sourceType.replaceAll("_"," ")} metrics={`${item.usedKnowledgeCount}/${item.knowledgeCount} used\n${item.assetCount} assets`}/>)}</Panel>
      <Panel title="Conversion rates" description="Observed outcomes per published asset, separated by territory and CTA.">{[...data.territoryRates.map(item=>({...item,prefix:"Territory"})),...data.ctaRates.map(item=>({...item,prefix:"CTA"}))].map(item=><Row key={`${item.prefix}-${item.id}`} title={item.name} subtitle={`${item.prefix} · ${item.publications} publications`} metrics={`${item.conversions} conversions\n${rate(item.rate)}`}/>)}</Panel>
      <Panel title="Audience quality" description="Verified identity is never conflated with an inferred interaction."><div className={styles.quality}><div><strong>{data.audienceQuality.verifiedIdentities}</strong><span>Verified identities</span></div><div><strong>{data.audienceQuality.inferredInteractions}</strong><span>Inferred interactions</span></div></div><p className={styles.note}>{data.audienceQuality.note}</p></Panel>
      <Panel title="Editorial reviews" description="Stored monthly decisions, never overwritten." wide>{reviews.length===0?<Empty>Generate the first review after publishing or recording outcomes.</Empty>:reviews.map(review=><article className={styles.review} key={review.id}><strong>{review.periodStart} to {review.periodEnd}</strong><p>{review.summary}</p><ul>{review.recommendedActions.map(action=><li key={action}>{action}</li>)}</ul></article>)}</Panel>
    </div>
  </section>;
}

function Metric({label,value}:{label:string;value:string}){return <div className={styles.tile}><span>{label}</span><strong>{value}</strong></div>}
function Panel({title,description,children,wide=false}:{title:string;description:string;children:React.ReactNode;wide?:boolean}){return <div className={`${styles.panel} ${wide?styles.wide:""}`}><h3>{title}</h3><p>{description}</p>{children}</div>}
function Row({title,subtitle,metrics}:{title:string;subtitle:string;metrics:string}){return <div className={styles.row}><div><strong>{title}</strong><span>{subtitle}</span></div><div className={styles.metrics}>{metrics}</div></div>}
function Empty({children}:{children:React.ReactNode}){return <p className={styles.empty}>{children}</p>}
