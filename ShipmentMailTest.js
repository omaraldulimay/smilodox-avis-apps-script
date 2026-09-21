function avisIstPackliste_(name) {
  const n=String(name).normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  return /\.xlsx$/.test(n) && !/invoice|rechnung/.test(n) && /packing[\s_-]*list|packliste/.test(n);
}
// Nur manueller Selbst-Mail-Test; keine Nachricht wird verändert oder versendet.
function avisShipmentSpreadsheet_() {
  const me='kontakt@firma.example';
  if(Session.getEffectiveUser().getEmail().toLowerCase()!==me)throw Error('Diesen Test bitte mit kontakt@firma.example ausführen.');
  const address=x=>{const m=String(x).match(/<([^>]+)>/);return(m?m[1]:String(x)).trim().toLowerCase();};
  const threads=GmailApp.search('in:anywhere -in:trash -in:spam from:kontakt@firma.example to:'+me+' subject:"08.09.2026 SHIPMENT DOCUMENTS" has:attachment newer_than:7d',0,100);
  if(threads.length===100)throw Error('Zu viele Test-Mails: Suche bitte eingrenzen.');
  const cutoff=Date.now()-7*24*60*60*1000;
  const messages=threads.flatMap(t=>t.getMessages()).filter(m=>m.getSubject().trim().toLowerCase()==='fwd: 08.09.2026 shipment documents'&&address(m.getFrom())==='kontakt@firma.example'&&m.getTo().split(',').some(x=>address(x)===me)&&m.getDate().getTime()>=cutoff);
  if(messages.length!==1)throw Error('Erwartet genau eine Weiterleitung von kontakt@firma.example mit Betreff Fwd: 08.09.2026 SHIPMENT DOCUMENTS in den letzten 7 Tagen; gefunden: '+messages.length);
  const message=messages[0];
  const attachments=message.getAttachments({includeInlineImages:false,includeAttachments:true}).filter(a=>avisIstPackliste_(a.getName()));
  if(attachments.length!==1)throw Error('Erwartet genau eine erkennbare XLSX-Packliste; gefunden: '+attachments.length);
  const attachment=attachments[0],folder='0AIMzqfJfA7IhUk9PVA';
  const hash=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,attachment.getBytes()).map(b=>(b&255).toString(16).padStart(2,'0')).join('');
  const name='TEST_MAIL_PACKLISTE_'+message.getId()+'_'+hash.slice(0,12);
  const found=Drive.Files.list({q:"'"+folder+"' in parents and trashed=false and name='"+name+"'",fields:'files(id)',supportsAllDrives:true,includeItemsFromAllDrives:true}).files||[];
  if(found.length>1)throw Error('Mehrere konvertierte Testkopien gefunden.');
  const id=found.length?found[0].id:Drive.Files.create({name,mimeType:'application/vnd.google-apps.spreadsheet',parents:[folder]},attachment.copyBlob().setContentType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),{supportsAllDrives:true,fields:'id'}).id;
  console.log('Quelle: Beispiel-Weiterleitung SHIPMENT DOCUMENTS; XLSX-Anhang als separate Testtabelle eingelesen.');
  return SpreadsheetApp.openById(id);
}

// Manueller Test: liest ausschließlich die beiden freigegebenen Testkopien.
function testShipmentMail() {
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(1000))throw Error('Ein Test läuft bereits.');
  try {
    const stockBook=SpreadsheetApp.openById('REPLACE_WITH_GOOGLE_ID');
    const packBook=avisShipmentSpreadsheet_();
    const stockSheets=stockBook.getSheets().filter(s=>['Var.number','Attribut','EAN13'].every(h=>s.getRange(1,1,1,s.getLastColumn()).getDisplayValues()[0].includes(h)));
    if(stockSheets.length!==1)throw Error('Stock-Blatt nicht eindeutig gefunden.');
    const sheet=stockSheets[0],headers=sheet.getRange(1,1,1,sheet.getLastColumn()).getDisplayValues()[0];
    const columns={};
    ['Var.number','Attribut','EAN13'].forEach(h=>{
      if(headers.filter(x=>x===h).length!==1)throw Error('Doppelte Stock-Spalte: '+h);
      columns[h]=sheet.getRange(2,headers.indexOf(h)+1,sheet.getLastRow()-1,1).getValues();
    });
    const stock=columns['Var.number'].map((_,i)=>Object.fromEntries(Object.keys(columns).map(h=>[h,columns[h][i][0]])));
    const candidates=packBook.getSheets().filter(s=>s.getRange(1,1,Math.min(20,s.getLastRow()),s.getLastColumn()).getDisplayValues().some(r=>r.includes('ART. NO')&&r.includes('SENT PCS.')));
    if(candidates.length!==1)throw Error('Packlisten-Blatt nicht eindeutig gefunden.');
    const result=buildAvis(stock,candidates[0].getDataRange().getValues());
    const report={...result,csv:undefined,testOnly:true};
    const folderId='0AIMzqfJfA7IhUk9PVA';
    const props=PropertiesService.getScriptProperties();
    const digest=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,JSON.stringify(report)+result.csv).map(b=>(b&255).toString(16).padStart(2,'0')).join('');
    const outputs=[['report','TEST-Pruefbericht-'+digest.slice(0,12)+'.json',JSON.stringify(report,null,2),'application/json'],['csv',(result.ready?'TEST_AVIS_':'VORSCHAU_UNVOLLSTAENDIG_NICHT_IMPORTIEREN_')+digest.slice(0,12)+'.csv',result.csv,'text/csv']];
    // Drive API mit Shared-Drive-Unterstützung; keine Eingabedatei wird verändert.
    const links=[];
    outputs.forEach(([kind,name,text,mime])=>{
      const k='test-output-'+digest+'-'+kind;
      let id=props.getProperty(k);
      if(!id){
        const existing=Drive.Files.list({q:"'"+folderId+"' in parents and trashed = false and name = '"+name+"'",fields:'files(id)',supportsAllDrives:true,includeItemsFromAllDrives:true}).files||[];
        if(existing.length>1)throw Error('Mehrere gleichnamige Testausgaben gefunden.');
        id=existing.length?existing[0].id:Drive.Files.create({name,mimeType:mime,parents:[folderId]},Utilities.newBlob(text,mime,name),{supportsAllDrives:true,fields:'id'}).id;
        props.setProperty(k,id);
      }
      links.push('https://drive.google.com/file/d/'+id+'/view');
    });
    console.log(JSON.stringify({status:result.ready?'Testdatei vollständig':'Testvorschau mit offenen Zuordnungen',...result.summary,output:links},null,2));
  } finally {lock.releaseLock();}
}
