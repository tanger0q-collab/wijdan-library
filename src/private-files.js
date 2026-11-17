const chunkSize = 768 * 1024;
const partSize = 16 * 1024 * 1024;
const objectLimit = 96 * 1024 * 1024;
const storedLimit = 350 * 1024 * 1024;
const good = response => response?.success;

function error(message,status) {return Object.assign(new Error(message),{status});}

async function bytesFrom(source) {
  if (typeof source==='string')return new TextEncoder().encode(source);
  if (source instanceof Uint8Array)return source;
  return new Uint8Array(await new Response(source).arrayBuffer());
}

export class PrivateFiles {
  constructor(db) {this.db=db;}

  async head(key) {
    const object=await this.db.prepare('SELECT type,size,tag FROM objects WHERE key=?').bind(key).first();
    return object && {
      size:object.size,httpEtag:'"'+object.tag+'"',
      writeHttpMetadata(headers){headers.set('Content-Type',object.type);},
    };
  }

  async checkSpace(size) {
    const stored=await this.db.prepare('SELECT COALESCE(SUM(size),0) AS n FROM objects').first();
    if (size>objectLimit || stored.n+size>storedLimit) throw error('Storage Full. Remove unused files or activate larger cloud storage.',413);
  }

  async put(key, source, options={}) {
    if (await this.head(key)) return null;
    const bytes=await bytesFrom(source);
    await this.checkSpace(bytes.length);
    const tag=crypto.randomUUID();
    const temporary=key+':'+tag;
    try {
      const rows=[];
      for(let start=0;start<bytes.length;start+=chunkSize){
        rows.push(this.db.prepare('INSERT INTO object_parts VALUES (?,?,?)').bind(temporary,Math.floor(start/chunkSize),bytes.slice(start,start+chunkSize).buffer));
      }
      for(let i=0;i<rows.length;i+=5) await this.db.batch(rows.slice(i,i+5));
      const result=await this.db.batch([
        this.db.prepare('INSERT INTO objects VALUES (?,?,?,?)').bind(key,options.httpMetadata?.contentType||'application/octet-stream',bytes.length,tag),
        this.db.prepare('UPDATE object_parts SET object_key=? WHERE object_key=?').bind(key,temporary),
      ]);
      if(!result.every(good)) throw error('Save failed.',500);
      return {size:bytes.length};
    } catch(err) {
      await this.db.prepare('DELETE FROM object_parts WHERE object_key=?').bind(temporary).run();
      if(await this.head(key))return null;
      throw err;
    }
  }

  async get(key,{range={}}={}) {
    const object=await this.head(key);
    if(!object)return null;
    const stride=object.httpEtag.startsWith('"m-') ? 512*1024 : chunkSize;
    const offset=range.offset||0;
    const end=offset+(range.length ?? object.size);
    let position=offset;
    const db=this.db;
    const body=new ReadableStream({
      async pull(controller){
        if(position>=end){controller.close();return;}
        const first=Math.floor(position/stride);
        const last=Math.min(first+3,Math.floor((end-1)/stride));
        const rows=await db.prepare('SELECT chunk,bytes FROM object_parts WHERE object_key=? AND chunk BETWEEN ? AND ? ORDER BY chunk').bind(key,first,last).all();
        if(!rows.results.length){controller.error(new Error('Missing file data.'));return;}
        for(const row of rows.results){
          const source=new Uint8Array(row.bytes);
          const start=Math.max(0,position-row.chunk*stride);
          const count=Math.min(source.length-start,end-position);
          if(count>0){controller.enqueue(source.subarray(start,start+count));position+=count;}
        }
      },
    });
    return {...object,body};
  }

  async delete(key) {
    await this.db.batch([
      this.db.prepare('DELETE FROM object_parts WHERE object_key=?').bind(key),
      this.db.prepare('DELETE FROM objects WHERE key=?').bind(key),
    ]);
  }

  async createMultipartUpload(key,{httpMetadata}={}) {
    const id=crypto.randomUUID();
    await this.db.prepare('INSERT INTO multipart_jobs VALUES (?,?,?,?)').bind(id,key,httpMetadata.contentType,Date.now()).run();
    return {uploadId:id};
  }

  resumeMultipartUpload(key,id) {
    return {
      uploadPart:(part,body)=>this.uploadPart(key,id,part,body),
      complete:parts=>this.complete(key,id,parts),
      abort:()=>this.abort(key,id),
    };
  }

  async job(key,id) {
    const job=await this.db.prepare('SELECT * FROM multipart_jobs WHERE id=? AND object_key=?').bind(id,key).first();
    if(!job)throw error('Upload session expired.',404);
    return job;
  }

  async uploadPart(key,id,part,body) {
    await this.job(key,id);
    if(part<1||part>Math.ceil(objectLimit/partSize))throw error('File is larger than 96 MB.',413);
    const data=await bytesFrom(body);
    if(!data.length||data.length>partSize)throw error('Invalid upload part.',413);
    const start=(part-1)*partSize;
    // 16 MiB is not an even multiple of chunkSize. Use 512 KiB for the transport
    // grid and identify that size from the stored multipart tag.
    const dataChunk=512*1024;
    const rows=[];
    for(let offset=0;offset<data.length;offset+=dataChunk){
      rows.push(this.db.prepare('INSERT OR REPLACE INTO object_parts VALUES (?,?,?)').bind(id,(start+offset)/dataChunk,data.slice(offset,offset+dataChunk).buffer));
    }
    for(let i=0;i<rows.length;i+=5) await this.db.batch(rows.slice(i,i+5));
    await this.db.prepare('INSERT OR REPLACE INTO multipart_sizes VALUES (?,?,?)').bind(id,part,data.length).run();
    return {partNumber:part,etag:String(data.length)};
  }

  async complete(key,id,parts) {
    const job=await this.job(key,id);
    const {results}=await this.db.prepare('SELECT part,size FROM multipart_sizes WHERE job=? ORDER BY part').bind(id).all();
    if(!results.length||results.length!==parts.length||results.some(({part,size},i)=>part!==i+1||(i<results.length-1&&size!==partSize)))throw error('Upload is incomplete.',400);
    const size=results.reduce((total,row)=>total+row.size,0);
    await this.checkSpace(size);
    await this.db.batch([
      this.db.prepare('INSERT INTO objects VALUES (?,?,?,?)').bind(key,job.type,size,'m-'+id),
      this.db.prepare('UPDATE object_parts SET object_key=? WHERE object_key=?').bind(key,id),
      this.db.prepare('DELETE FROM multipart_sizes WHERE job=?').bind(id),
      this.db.prepare('DELETE FROM multipart_jobs WHERE id=?').bind(id),
    ]);
    return {size};
  }

  async abort(key,id) {
    await this.job(key,id);
    await this.db.batch([
      this.db.prepare('DELETE FROM object_parts WHERE object_key=?').bind(id),
      this.db.prepare('DELETE FROM multipart_sizes WHERE job=?').bind(id),
      this.db.prepare('DELETE FROM multipart_jobs WHERE id=?').bind(id),
    ]);
  }
}
