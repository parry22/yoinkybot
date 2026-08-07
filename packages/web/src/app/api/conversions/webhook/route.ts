import { NextResponse } from "next/server";
import { recordConversionEvent } from "@yoink/backend/web";

export const runtime="nodejs"; export const dynamic="force-dynamic";
export async function POST(req:Request){
  const body=await req.json().catch(()=>({})) as Record<string,unknown>;
  try{
    if(typeof body.actionId!=="string"||typeof body.token!=="string"||typeof body.eventType!=="string"||typeof body.deduplicationKey!=="string"||typeof body.occurredAt!=="string")throw new Error("Missing conversion event fields.");
    const result=await recordConversionEvent({actionId:body.actionId,token:body.token,eventType:body.eventType,deduplicationKey:body.deduplicationKey,occurredAt:body.occurredAt,assetId:typeof body.assetId==="string"?body.assetId:null,publicationId:typeof body.publicationId==="string"?body.publicationId:null,campaignId:typeof body.campaignId==="string"?body.campaignId:null,value:typeof body.value==="number"?body.value:null,currency:typeof body.currency==="string"?body.currency:null,metadata:body.metadata&&typeof body.metadata==="object"?body.metadata as Record<string,unknown>:undefined});
    return NextResponse.json(result,{status:result.duplicate?200:201});
  }catch(error){const message=error instanceof Error?error.message:"Invalid conversion event.";return NextResponse.json({error:message},{status:400});}
}
