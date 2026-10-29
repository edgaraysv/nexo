import { permissionsForCompanyRoles, type CompanyPermission } from './authorization.js';

export interface CompanySite { id:string;code:string;name:string;status:string;networks:string[] }
export interface DeclaredDevice { id:string;siteId?:string;name:string;platform:string;status:string }
export interface CompanyUser { userId:string;email:string;status:string;roles:string[] }
export interface AccessPolicy { id:string;name:string;effect:'allow'|'deny';action:string;resourceType:string;status:string;revision:number;validFrom?:string;validUntil?:string }
export interface CompanyAuditEvent { id:string;actorUserId?:string;action:string;resourceType:string;resourceId?:string;createdAt:string }
export interface CompanyAuditPage { items:CompanyAuditEvent[]; total:number }
export interface CompanyRoleExportGrant { role:string; enabled:boolean }
export interface CompanyRepository {
  permissionsFor(tenantId:string,userId:string):Promise<CompanyPermission[]>;
  listSites(tenantId:string):Promise<CompanySite[]>;
  createSite(tenantId:string,input:{code:string;name:string;networks:string[]},actor:string):Promise<CompanySite>;
  listDevices(tenantId:string):Promise<DeclaredDevice[]>;
  declareDevice(tenantId:string,input:{siteId?:string;name:string;platform:string},actor:string):Promise<DeclaredDevice>;
  listUsers(tenantId:string):Promise<CompanyUser[]>;
  setUserRole(tenantId:string,userId:string,role:string,actor:string):Promise<void>;
  createInvitation(tenantId:string,input:{email:string;role:string;tokenHash:string;expiresAt:number},actor:string):Promise<void>;
  acceptInvitation(tokenHash:string,userId:string,email:string):Promise<{tenantId:string;role:string}|undefined>;
  listPolicies(tenantId:string):Promise<AccessPolicy[]>;
  createPolicy(tenantId:string,input:Omit<AccessPolicy,'id'|'revision'>,actor:string):Promise<AccessPolicy>;
  updatePolicy(tenantId:string,id:string,input:Omit<AccessPolicy,'id'|'revision'>,expectedRevision:number,actor:string):Promise<AccessPolicy>;
  summary(tenantId:string):Promise<{sites:number;devices:number;users:number;activePolicies:number}>;
  listAudit(tenantId:string,options:{limit:number;offset:number;action?:string;resourceType?:string;from?:string;until?:string}):Promise<CompanyAuditPage>;
  listExportGrants(tenantId:string):Promise<CompanyRoleExportGrant[]>;
  setExportGrant(tenantId:string,role:string,enabled:boolean,actor:string):Promise<{changed:boolean}>;
}

export class MemoryCompanyRepository implements CompanyRepository {
  private readonly sites=new Map<string,CompanySite[]>();private readonly devices=new Map<string,DeclaredDevice[]>();private readonly users=new Map<string,CompanyUser[]>();private readonly invitations=new Map<string,{tenantId:string;email:string;role:string;expiresAt:number;consumed:boolean}>();private readonly policies=new Map<string,AccessPolicy[]>();private readonly auditEvents=new Map<string,CompanyAuditEvent[]>();private readonly exportGrants=new Map<string,Set<string>>();
  constructor(seedUsers:Record<string,CompanyUser[]>={}){for(const[k,v]of Object.entries(seedUsers))this.users.set(k,v);}
  async permissionsFor(t:string,userId:string){const user=(this.users.get(t)??[]).find(x=>x.userId===userId&&x.status==='active');if(!user)return[];const permissions=permissionsForCompanyRoles(user.roles),grants=this.exportGrants.get(t);if(grants&&user.roles.some(role=>grants.has(role)))permissions.push('company.report.export');return[...new Set(permissions)];}
  async listSites(t:string){return this.sites.get(t)??[];} async createSite(t:string,input:{code:string;name:string;networks:string[]}){const list=this.sites.get(t)??[];if(list.some(x=>x.code===input.code))throw new Error('conflict');const site={id:crypto.randomUUID(),...input,status:'active'};list.push(site);this.sites.set(t,list);return site;}
  async listDevices(t:string){return this.devices.get(t)??[];} async declareDevice(t:string,input:{siteId?:string;name:string;platform:string}){if(input.siteId&&!(this.sites.get(t)??[]).some(x=>x.id===input.siteId))throw new Error('site_not_found');const item={id:crypto.randomUUID(),...input,status:'declared'};const list=this.devices.get(t)??[];list.push(item);this.devices.set(t,list);return item;}
  async listUsers(t:string){return this.users.get(t)??[];} async createInvitation(t:string,input:{email:string;role:string;tokenHash:string;expiresAt:number}){this.invitations.set(input.tokenHash,{tenantId:t,email:input.email,role:input.role,expiresAt:input.expiresAt,consumed:false});}
  async setUserRole(t:string,userId:string,role:string,actor:string){const users=this.users.get(t)??[],target=users.find(x=>x.userId===userId&&x.status==='active');if(!target)throw new Error('not_found');if(target.roles.includes('company.admin')&&role!=='company.admin'&&users.filter(x=>x.status==='active'&&x.roles.includes('company.admin')).length<=1)throw new Error('last_admin');target.roles=[role];const events=this.auditEvents.get(t)??[];events.unshift({id:crypto.randomUUID(),actorUserId:actor,action:'user.role_changed',resourceType:'membership',resourceId:userId,createdAt:new Date().toISOString()});this.auditEvents.set(t,events);}
  async acceptInvitation(hash:string,userId:string,email:string){const i=this.invitations.get(hash);if(!i||i.consumed||i.expiresAt<=Date.now()||i.email!==email)return undefined;i.consumed=true;const list=this.users.get(i.tenantId)??[];if(!list.some(x=>x.userId===userId))list.push({userId,email,status:'active',roles:[i.role]});this.users.set(i.tenantId,list);return{tenantId:i.tenantId,role:i.role};}
  async listPolicies(t:string){return this.policies.get(t)??[];} async createPolicy(t:string,input:Omit<AccessPolicy,'id'|'revision'>){const item={...input,id:crypto.randomUUID(),revision:1};const list=this.policies.get(t)??[];list.push(item);this.policies.set(t,list);return item;}
  async updatePolicy(t:string,id:string,input:Omit<AccessPolicy,'id'|'revision'>,expected:number){const item=(this.policies.get(t)??[]).find(x=>x.id===id);if(!item||item.revision!==expected)throw new Error('revision_conflict');Object.assign(item,input,{revision:item.revision+1});return item;}
  async summary(t:string){return{sites:(this.sites.get(t)??[]).length,devices:(this.devices.get(t)??[]).length,users:(this.users.get(t)??[]).length,activePolicies:(this.policies.get(t)??[]).filter(x=>x.status==='active').length};}
  async listAudit(t:string,options:{limit:number;offset:number;action?:string;resourceType?:string;from?:string;until?:string}){const filtered=(this.auditEvents.get(t)??[]).filter(event=>(!options.action||event.action===options.action)&&(!options.resourceType||event.resourceType===options.resourceType)&&(!options.from||Date.parse(event.createdAt)>=Date.parse(options.from))&&(!options.until||Date.parse(event.createdAt)<Date.parse(options.until))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));return{items:filtered.slice(options.offset,options.offset+options.limit),total:filtered.length};}
  async listExportGrants(t:string){const existing=new Set((this.users.get(t)??[]).flatMap(user=>user.roles)),granted=this.exportGrants.get(t)??new Set<string>();return[...existing].sort().map(role=>({role,enabled:granted.has(role)}));}
  async setExportGrant(t:string,role:string,enabled:boolean,actor:string){if(!(this.users.get(t)??[]).some(user=>user.roles.includes(role)))throw new Error('not_found');const grants=this.exportGrants.get(t)??new Set<string>(),wasEnabled=grants.has(role);if(enabled)grants.add(role);else grants.delete(role);this.exportGrants.set(t,grants);if(wasEnabled!==enabled){const events=this.auditEvents.get(t)??[];events.unshift({id:crypto.randomUUID(),actorUserId:actor,action:enabled?'report.export_permission.granted':'report.export_permission.revoked',resourceType:'role',resourceId:role,createdAt:new Date().toISOString()});this.auditEvents.set(t,events);}return{changed:wasEnabled!==enabled};}
}
