// Bildet den kompletten Weg nach, den ein Mensch im Portal geht:
// Bestellung anlegen (leer) -> Avis-CSV hochladen -> Verarbeitung anstossen.
// Legt niemals Positionen direkt an, umgeht nie die Datenbank -- alles laeuft
// ueber dieselben Adressen, die das Portal selbst beim Klicken aufruft.
// Per Netzwerk-Analyse ermittelt am 21.09.2026:
//   1. POST /api/logistics/purchase_orders            -> legt die Bestellung an (Positionen leer)
//   2. POST /api/file_upload                           -> liefert eine befristete S3-Upload-Adresse
//   3. PUT  <diese Adresse>                             -> die eigentliche CSV-Datei
//   4. POST /api/logistics/purchase_orders_import/{id} -> stoesst die Verarbeitung an
//
// Anmeldung ueber ein eigenes Automatisierungs-Konto (Cognito), nicht ueber
// eine persoenliche Anmeldung -- damit haengt nichts an einer einzelnen Person.
//
// Erwartete Skripteigenschaften:
//   PORTAL_COGNITO_CLIENT_ID   (bekannt: REPLACE_WITH_CLIENT_ID)
//   PORTAL_AUTOMATION_USER     E-Mail des Automatisierungs-Kontos
//   PORTAL_AUTOMATION_PASS     dessen Passwort

const PORTAL_BASIS_URL = 'https://portal.example.com';
const PORTAL_COGNITO_REGION = 'eu-west-1';

// Meldet das Automatisierungs-Konto bei Cognito an, ein einzelner HTTPS-Aufruf.
// Wird bei jedem Lauf neu geholt -- kein Ablaufproblem, kein Browser noetig.
function portalToken_(){
  const props=PropertiesService.getScriptProperties();
  const clientId=props.getProperty('PORTAL_COGNITO_CLIENT_ID');
  const user=props.getProperty('PORTAL_AUTOMATION_USER');
  const pass=props.getProperty('PORTAL_AUTOMATION_PASS');
  const fehlend=['PORTAL_COGNITO_CLIENT_ID','PORTAL_AUTOMATION_USER','PORTAL_AUTOMATION_PASS']
    .filter(k=>!props.getProperty(k));
  if(fehlend.length)throw Error('Skripteigenschaften fuer die Portal-Anmeldung fehlen: '+fehlend.join(', '));

  const antwort=UrlFetchApp.fetch('https://cognito-idp.'+PORTAL_COGNITO_REGION+'.amazonaws.com/',{
    method:'post',
    contentType:'application/x-amz-json-1.1',
    headers:{'X-Amz-Target':'AWSCognitoIdentityProviderService.InitiateAuth'},
    payload:JSON.stringify({
      AuthFlow:'USER_PASSWORD_AUTH',
      ClientId:clientId,
      AuthParameters:{USERNAME:user,PASSWORD:pass}
    }),
    muteHttpExceptions:true
  });
  const code=antwort.getResponseCode(), text=antwort.getContentText();
  if(code!==200)throw Error('Portal-Anmeldung fehlgeschlagen (HTTP '+code+'): '+text.slice(0,300));
  const antwortDaten=JSON.parse(text);
  const ergebnis=antwortDaten.AuthenticationResult;
  if(!ergebnis||!ergebnis.IdToken){
    // Cognito verlangt haeufig einen Zusatzschritt statt sofort ein Token zu
    // liefern (z. B. Passwortaenderung beim ersten Login). Rohantwort zeigen,
    // statt blind zu raten.
    throw Error('Portal-Anmeldung ohne Token. Cognito-Antwort: '+JSON.stringify(antwortDaten).slice(0,500));
  }
  return ergebnis.IdToken;
}

// Fuehrt einen authentifizierten Aufruf gegen das Portal-Backend aus und gibt
// die geparste JSON-Antwort zurueck (oder null bei leerem Rumpf).
function portalAufruf_(token,pfad,methode,payload){
  const optionen={method:methode,headers:{Authorization:'Bearer '+token},muteHttpExceptions:true};
  if(payload!==undefined){
    optionen.contentType='application/json';
    optionen.payload=JSON.stringify(payload);
  }
  const antwort=UrlFetchApp.fetch(PORTAL_BASIS_URL+pfad,optionen);
  const code=antwort.getResponseCode(), text=antwort.getContentText();
  if(code<200||code>=300)throw Error('Portal-Aufruf '+pfad+' antwortete mit HTTP '+code+': '+text.slice(0,300));
  return text?JSON.parse(text):null;
}

// Legt eine LEERE Bestellung an -- genau wie der "Erstellen"-Knopf im Portal.
// Positionen kommen erst im zweiten Schritt per Avis-Upload dazu.
// Rueckgabe: die neu angelegte Bestellung (enthaelt .id).
function avisPortalBestellungAnlegen_(token,konfig){
  return portalAufruf_(token,'/api/logistics/purchase_orders','post',{
    instance_key:konfig.instanceKey,
    items:[],
    items_check:'10_percent',
    planned_delivery_date:konfig.anlieferdatum,
    reference:konfig.referenz||null,
    status:2, // Offen -- bewusst nicht Entwurf (1), damit die Bestellung in der
              // normalen Arbeitsansicht sichtbar ist und nicht uebersehen wird
    supplier_id:konfig.supplierId,
    supplier_name:konfig.supplierName,
    number_of_cartons:konfig.numberOfCartons||null
  });
}

// Laedt die CSV in eine (gerade erst angelegte oder bereits bestehende)
// Bestellung hoch und stoesst die Verarbeitung an.
function avisPortalCsvHochladen_(token,bestellungId,csvText){
  const dateiname='purchase_orders/'+bestellungId+'.csv';
  const anmeldung=portalAufruf_(token,'/api/file_upload','post',
    {file_name:dateiname,content_type:'text/csv'});
  if(!anmeldung||!anmeldung.upload_url)throw Error('Keine Upload-Adresse vom Portal erhalten.');

  const s3Antwort=UrlFetchApp.fetch(anmeldung.upload_url,{
    method:'put',contentType:'text/csv',payload:csvText,muteHttpExceptions:true
  });
  const s3Code=s3Antwort.getResponseCode();
  if(s3Code<200||s3Code>=300)throw Error('Hochladen zu S3 fehlgeschlagen (HTTP '+s3Code+'): '+s3Antwort.getContentText().slice(0,300));

  // PUT, nicht POST -- empirisch ermittelt, POST antwortet hier mit 405.
  portalAufruf_(token,'/api/logistics/purchase_orders_import/'+bestellungId,'put');
}

// Kompletter Vorgang: Bestellung anlegen, CSV hochladen, Verarbeitung anstossen.
// konfig: {instanceKey, supplierId, supplierName, anlieferdatum, referenz}
// Rueckgabe: {bestellungId}
function avisPortalKomplett_(konfig,csvText){
  const token=portalToken_();
  const bestellung=avisPortalBestellungAnlegen_(token,konfig);
  avisPortalCsvHochladen_(token,bestellung.id,csvText);
  return {bestellungId:bestellung.id};
}

// Liefertermin aus dem Dateinamen (Format TT.MM.JJJJ) im vom Portal erwarteten
// ISO-Format mit Zeitzone. Ohne Fund: morgen, als sichere Vorgabe.
function avisPortalLieferdatum_(dateiname){
  const m=String(dateiname).match(/(\d{2})[. _-](\d{2})[. _-](\d{4})/);
  const datum=m?new Date(Number(m[3]),Number(m[2])-1,Number(m[1])):(function(){const t=new Date();t.setDate(t.getDate()+1);return t;})();
  return Utilities.formatDate(datum,'Europe/Berlin',"yyyy-MM-dd'T'00:00:00.000XXX");
}

// Bindeglied zum Hauptablauf: nutzt dieselbe Konfiguration (Mandant,
// Lieferantennummern) wie das Datenbank-Testmodul, damit die echten Werte nur
// an einer Stelle gepflegt werden muessen. Greift auch bei unvollstaendiger
// Zuordnung (siehe unten), aber nur fuer Lieferanten, deren Nummer als
// Skripteigenschaft hinterlegt ist (Stand 21.09.2026: Lieferant I und
// Lieferant J sind beide hinterlegt).
// Rueckgabe: {geschrieben:true, bestellungId} oder {geschrieben:false, grund}
// Legt IMMER eine Bestellung mit den sicher zugeordneten Positionen an, auch
// wenn nicht alle Zeilen der Packliste zugeordnet werden konnten. Fehlende
// Zeilen werden nicht erraten oder ausgelassen -- sie fehlen dann schlicht in
// der Bestellung und werden ueber die Referenz sichtbar gemacht, damit jemand
// sie manuell nachtraegt. Nur wenn ueberhaupt keine einzige Position sicher
// zugeordnet werden konnte, entsteht nichts.
function avisPortalSchreiben_(result,source,supplier){
  const konfig=avisDbKonfig_();
  if(!konfig.bereit)return {geschrieben:false,grund:'Kern-Skripteigenschaften fehlen: '+konfig.fehlend.join(', ')};
  if(!result.rows||!result.rows.length)return {geschrieben:false,grund:'Keine zugeordneten Positionen.'};
  const supplierId=konfig.lieferanten[supplier];
  if(supplierId==null)return {geschrieben:false,grund:'Lieferantennummer fuer '+supplier+' ist nicht hinterlegt.'};

  const quote=x=>/[",\r\n]/.test(String(x))?'"'+String(x).replace(/"/g,'""')+'"':String(x);
  const csv=[['EAN','Var-Nr.','','QUANTITY','BATCH','NOTE'],...result.rows].map(r=>r.map(quote).join(',')).join('\n')+'\n';
  // Die Warnung steht direkt in der Referenz, die in der Portal-Liste sichtbar
  // ist -- ohne dass wir am Portal selbst etwas aendern muessen.
  const warnung=result.ready?'':' ⚠ '+result.errors.length+' von '+result.summary.positions+' Positionen ungeklaert';
  const ergebnis=avisPortalKomplett_({
    instanceKey:konfig.instanceKey,
    supplierId:supplierId,
    supplierName:supplier==='Lieferant I'?'Lieferant I; Yenibosna Merkez Mahallesi':supplier,
    anlieferdatum:avisPortalLieferdatum_(source.attachment),
    referenz:supplier+' '+source.attachment+warnung,
    numberOfCartons:result.summary.boxes||null
  },csv);
  return {geschrieben:true,bestellungId:ergebnis.bestellungId,vollstaendig:result.ready,
          offen:result.ready?0:result.errors.length};
}

// Einmaliger Test: Anmeldung pruefen, ohne etwas anzulegen.
function avisPortalAnmeldungTesten(){
  const token=portalToken_();
  console.log('Anmeldung erfolgreich, Token erhalten (Laenge '+token.length+' Zeichen).');
}

// EINMALIG auszufuehren, direkt nach dem Anlegen des Automatisierungs-Kontos.
// Cognito verlangt beim allerersten Login eine Bestaetigung des Passworts,
// selbst wenn es beim Anlegen schon als "fest" markiert wurde. Diese Funktion
// beantwortet genau diese eine Aufforderung mit demselben Passwort, danach
// gilt es als dauerhaft und avisPortalAnmeldungTesten funktioniert normal.
// Kann gefahrlos ein zweites Mal ausgefuehrt werden -- danach meldet sie nur,
// dass keine Bestaetigung mehr noetig ist.
function avisPortalPasswortEinmaligBestaetigen(){
  const props=PropertiesService.getScriptProperties();
  const clientId=props.getProperty('PORTAL_COGNITO_CLIENT_ID');
  const user=props.getProperty('PORTAL_AUTOMATION_USER');
  const pass=props.getProperty('PORTAL_AUTOMATION_PASS');
  const fehlend=['PORTAL_COGNITO_CLIENT_ID','PORTAL_AUTOMATION_USER','PORTAL_AUTOMATION_PASS']
    .filter(k=>!props.getProperty(k));
  if(fehlend.length)throw Error('Skripteigenschaften fehlen: '+fehlend.join(', '));

  const erster=UrlFetchApp.fetch('https://cognito-idp.'+PORTAL_COGNITO_REGION+'.amazonaws.com/',{
    method:'post',
    contentType:'application/x-amz-json-1.1',
    headers:{'X-Amz-Target':'AWSCognitoIdentityProviderService.InitiateAuth'},
    payload:JSON.stringify({AuthFlow:'USER_PASSWORD_AUTH',ClientId:clientId,
      AuthParameters:{USERNAME:user,PASSWORD:pass}}),
    muteHttpExceptions:true
  });
  const ersteDaten=JSON.parse(erster.getContentText());

  if(ersteDaten.AuthenticationResult){
    console.log('Keine Bestaetigung noetig -- Konto ist bereits vollstaendig eingerichtet.');
    return;
  }
  if(ersteDaten.ChallengeName!=='NEW_PASSWORD_REQUIRED'){
    throw Error('Unerwartete Cognito-Antwort: '+JSON.stringify(ersteDaten).slice(0,500));
  }

  const zweiter=UrlFetchApp.fetch('https://cognito-idp.'+PORTAL_COGNITO_REGION+'.amazonaws.com/',{
    method:'post',
    contentType:'application/x-amz-json-1.1',
    headers:{'X-Amz-Target':'AWSCognitoIdentityProviderService.RespondToAuthChallenge'},
    payload:JSON.stringify({
      ClientId:clientId,
      ChallengeName:'NEW_PASSWORD_REQUIRED',
      Session:ersteDaten.Session,
      ChallengeResponses:{USERNAME:user,NEW_PASSWORD:pass}
    }),
    muteHttpExceptions:true
  });
  const zweiteCode=zweiter.getResponseCode(), zweiteText=zweiter.getContentText();
  if(zweiteCode!==200)throw Error('Bestaetigung fehlgeschlagen (HTTP '+zweiteCode+'): '+zweiteText.slice(0,500));
  const zweiteDaten=JSON.parse(zweiteText);
  if(!zweiteDaten.AuthenticationResult||!zweiteDaten.AuthenticationResult.IdToken){
    throw Error('Bestaetigung ohne Token in der Antwort: '+zweiteText.slice(0,500));
  }
  console.log('Passwort bestaetigt. Das Konto ist jetzt dauerhaft eingerichtet -- '
    +'avisPortalAnmeldungTesten sollte ab jetzt normal funktionieren.');
}

// Kompletter Testlauf mit einer winzigen, erfundenen Testliste (zwei Positionen).
// Legt eine ECHTE, sichtbare Testbestellung im Portal an -- bewusst klein und
// klar als Test erkennbar (Referenz beginnt mit "TEST-"), damit sie leicht
// wiederzufinden und zu entfernen ist.
function avisPortalKomplettTesten(){
  const morgen=new Date();
  morgen.setDate(morgen.getDate()+1);
  const konfig={
    instanceKey:'1',
    supplierId:690381,
    supplierName:'Lieferant I; Yenibosna Merkez Mahallesi',
    anlieferdatum:Utilities.formatDate(morgen,'Europe/Berlin',"yyyy-MM-dd'T'00:00:00.000XXX"),
    referenz:'TEST-'+Utilities.formatDate(new Date(),'Europe/Berlin','yyyyMMdd-HHmmss')
  };
  // Zwei echte, gueltige EAN aus einer frueheren Testpackliste.
  const csv='EAN,Var-Nr.,,QUANTITY\n4062517459920,55074-C1,"Anthrazit, S",5\n4062517459937,55074-C2,"Anthrazit, M",3\n';

  const ergebnis=avisPortalKomplett_(konfig,csv);
  console.log('Testbestellung angelegt: Id '+ergebnis.bestellungId+', Referenz '+konfig.referenz);
  console.log('Bitte im Portal pruefen: https://portal.example.com/logistics/purchase-orders/details/'+ergebnis.bestellungId);
}

// Einmalige Diagnose: probiert plausible Pfade fuer die Lieferantenliste durch,
// um herauszufinden, ob das Portal-Backend selbst eine Lieferantenverwaltung
// hat oder die Liste nur von Plenty durchreicht. Schreibt nichts.
function avisPortalLieferantenwegPruefen(){
  const token=portalToken_();
  const pfade=['/api/logistics/suppliers','/api/logistics/partners','/api/suppliers',
    '/api/logistics/purchase_orders/suppliers','/api/logistics/contacts'];
  pfade.forEach(function(pfad){
    const antwort=UrlFetchApp.fetch(PORTAL_BASIS_URL+pfad,{
      headers:{Authorization:'Bearer '+token},muteHttpExceptions:true
    });
    const code=antwort.getResponseCode();
    console.log(pfad+' -> HTTP '+code+' | '+antwort.getContentText().slice(0,200));
  });
}

// Prueft den echten Lieferanten-Pfad: liest die Liste (wie das Dropdown es
// tut) und probiert danach vorsichtig, ob das Portal selbst auch das Anlegen
// unterstuetzt -- mit einem absichtlich unvollstaendigen Rumpf, der bei
// echter Unterstuetzung einen Validierungsfehler (400) statt "nicht
// unterstuetzt" (405) auslösen sollte. Legt nichts an.
function avisPortalLieferantenApiPruefen(){
  const token=portalToken_();
  const pfad='/api/logistics/1/suppliers';

  const leseAntwort=UrlFetchApp.fetch(PORTAL_BASIS_URL+pfad,{
    headers:{Authorization:'Bearer '+token},muteHttpExceptions:true
  });
  console.log('GET '+pfad+' -> HTTP '+leseAntwort.getResponseCode());
  console.log('Beispiel-Antwort: '+leseAntwort.getContentText().slice(0,400));

  const schreibAntwort=UrlFetchApp.fetch(PORTAL_BASIS_URL+pfad,{
    method:'post',
    contentType:'application/json',
    headers:{Authorization:'Bearer '+token},
    payload:JSON.stringify({}),
    muteHttpExceptions:true
  });
  console.log('POST '+pfad+' (leerer Testrumpf) -> HTTP '+schreibAntwort.getResponseCode()
    +' | '+schreibAntwort.getContentText().slice(0,300));
}

// Einmaliger Test: was passiert, wenn eine CSV-Zeile eine unbekannte/erfundene
// EAN enthaelt statt einer echten? Legt eine winzige Testbestellung an, um das
// Verhalten des Imports zu sehen, bevor wir uns im Hauptablauf darauf verlassen.
function avisPortalUnbekannteEanTesten(){
  const morgen=new Date();morgen.setDate(morgen.getDate()+1);
  const konfig={
    instanceKey:'1',supplierId:690381,
    supplierName:'Lieferant I; Yenibosna Merkez Mahallesi',
    anlieferdatum:Utilities.formatDate(morgen,'Europe/Berlin',"yyyy-MM-dd'T'00:00:00.000XXX"),
    referenz:'TEST-UNBEKANNTE-EAN-'+Utilities.formatDate(new Date(),'Europe/Berlin','yyyyMMdd-HHmmss')
  };
  // Zeile 1: echte, bekannte EAN. Zeile 2: komplett erfunden, existiert nicht.
  const csv='EAN,Var-Nr.,,QUANTITY\n4062517459920,55074-C1,"Anthrazit, S",5\n0000000000000,UNBEKANNT,"Testartikel ohne Zuordnung",7\n';

  const ergebnis=avisPortalKomplett_(konfig,csv);
  console.log('Testbestellung angelegt: Id '+ergebnis.bestellungId);
  console.log('Bitte im Portal pruefen: https://portal.example.com/logistics/purchase-orders/details/'+ergebnis.bestellungId);
  console.log('Erwartet: Zeile 1 zeigt die echte Variante, Zeile 2 zeigt ??? -- was tatsaechlich passiert, muessen wir ansehen.');
}

// Einmaliger Test: zeigt das Portal den Inhalt der BATCH-Spalte auch dann an,
// wenn die EAN nicht zugeordnet werden kann? Legt eine winzige Testbestellung an.
function avisPortalBatchSpalteTesten(){
  const morgen=new Date();morgen.setDate(morgen.getDate()+1);
  const konfig={
    instanceKey:'1',supplierId:690381,
    supplierName:'Lieferant I; Yenibosna Merkez Mahallesi',
    anlieferdatum:Utilities.formatDate(morgen,'Europe/Berlin',"yyyy-MM-dd'T'00:00:00.000XXX"),
    referenz:'TEST-BATCH-SPALTE-'+Utilities.formatDate(new Date(),'Europe/Berlin','yyyyMMdd-HHmmss')
  };
  const csv='EAN,Var-Nr.,,QUANTITY,BATCH\n'
    +'4062517459920,55074-C1,"Anthrazit, S",5,\n'
    +'9999999000001,UNBEKANNT,"Testartikel ohne Zuordnung",7,26410 ANTRHAZIT XS - Keine Zuordnung\n';

  const ergebnis=avisPortalKomplett_(konfig,csv);
  console.log('Testbestellung angelegt: Id '+ergebnis.bestellungId);
  console.log('Bitte im Portal pruefen, ob die Charge-Spalte bei Zeile 2 den Text zeigt: '
    +'https://portal.example.com/logistics/purchase-orders/details/'+ergebnis.bestellungId);
}

// Einmaliger Test: nimmt die Anlegen-Schnittstelle ein parent_purchase_order_id
// Feld an, obwohl es in der Oberflaeche nicht vorkommt? Legt zwei winzige
// Testbestellungen an -- die zweite versucht, sich der ersten unterzuordnen.
function avisPortalZusammenfuehrenTesten(){
  const token=portalToken_();
  const morgen=new Date();morgen.setDate(morgen.getDate()+1);
  const datum=Utilities.formatDate(morgen,'Europe/Berlin',"yyyy-MM-dd'T'00:00:00.000XXX");

  const erste=portalAufruf_(token,'/api/logistics/purchase_orders','post',{
    instance_key:'1',items:[],items_check:'10_percent',planned_delivery_date:datum,
    reference:'TEST-ZUSAMMENFUEHREN-HAUPT-'+Utilities.formatDate(new Date(),'Europe/Berlin','HHmmss'),
    status:2,supplier_id:690381,supplier_name:'Lieferant I; Yenibosna Merkez Mahallesi'
  });
  console.log('Erste (Haupt-)Bestellung angelegt: Id '+erste.id);

  const zweite=portalAufruf_(token,'/api/logistics/purchase_orders','post',{
    instance_key:'1',items:[],items_check:'10_percent',planned_delivery_date:datum,
    reference:'TEST-ZUSAMMENFUEHREN-KIND-'+Utilities.formatDate(new Date(),'Europe/Berlin','HHmmss'),
    status:2,supplier_id:2342679,supplier_name:'Lieferant J',
    parent_purchase_order_id:erste.id
  });
  console.log('Zweite (Kind-)Bestellung angelegt: Id '+zweite.id);
  console.log('Antwort der zweiten Bestellung, komplett:');
  console.log(JSON.stringify(zweite));
  console.log('Enthaelt parent_purchase_order_id in der Antwort: '+('parent_purchase_order_id' in zweite));
}

// Einmaliger Test: laesst sich eine bestehende Bestellung ueberhaupt aendern
// (z. B. Status)? Nutzt eine der eigenen Testbestellungen (597), aendert nur
// die Referenz zu Testzwecken minimal, kein Risiko fuer echte Daten.
function avisPortalBestellungAendernTesten(){
  const token=portalToken_();
  const testId=597;
  ['put','patch'].forEach(function(methode){
    const antwort=UrlFetchApp.fetch(PORTAL_BASIS_URL+'/api/logistics/purchase_orders/'+testId,{
      method:methode,
      contentType:'application/json',
      headers:{Authorization:'Bearer '+token},
      payload:JSON.stringify({status:11}), // 11 = Storniert
      muteHttpExceptions:true
    });
    console.log(methode.toUpperCase()+' /purchase_orders/'+testId+' -> HTTP '+antwort.getResponseCode()
      +' | '+antwort.getContentText().slice(0,300));
  });
}

// Bestaetigt: bestehende Bestellungen lassen sich NICHT per PUT/PATCH aendern
// (HTTP 405, siehe avisPortalBestellungAendernTesten). Der einzige bestaetigt
// funktionierende Eingriff in eine bestehende Bestellung ist das Loeschen
// (DELETE, HTTP 204). Ein nachtraegliches "ersetzt durch..." IN der alten
// Bestellung ist damit technisch nicht moeglich. Gewaehlter Weg (Ansatz A):
// neue Bestellung mit den zusammengefuehrten Positionen anlegen, in deren
// Referenz auf die alten Nummern verweisen, danach die alten loeschen.

// Liest eine bestehende Bestellung komplett aus (inkl. Positionen).
function avisPortalDetailsHolen_(token,bestellungId){
  return portalAufruf_(token,'/api/logistics/purchase_orders/'+bestellungId,'get');
}

// Loescht eine bestehende Bestellung unwiderruflich. Bestaetigt per
// Netzwerk-Mitschnitt am 21.09.2026: DELETE .../purchase_orders/{id} -> HTTP 204.
function avisPortalBestellungLoeschen_(token,bestellungId){
  const antwort=UrlFetchApp.fetch(PORTAL_BASIS_URL+'/api/logistics/purchase_orders/'+bestellungId,{
    method:'delete',headers:{Authorization:'Bearer '+token},muteHttpExceptions:true
  });
  const code=antwort.getResponseCode();
  if(code!==204)throw Error('Loeschen von Bestellung '+bestellungId+' fehlgeschlagen (HTTP '+code+'): '
    +antwort.getContentText().slice(0,300));
}

// Diagnose, NICHT der eigentliche Zusammenfuehren-Lauf: zeigt die rohe Antwort
// von GET auf eine bestehende Bestellung, damit die tatsaechliche Form der
// Positionen (Feldnamen fuer EAN, Menge, Charge usw.) sichtbar wird, bevor
// avisPortalZusammenfuehren_ sich darauf verlaesst.
// Sucht sich die Bestellung selbst -- feste IDs aus frueheren Tests koennen
// inzwischen geloescht sein (z. B. 588 wurde bereits aufgeraeumt). Holt daher
// erst die aktuelle Liste und nimmt daraus die erste, die auch Positionen hat.
function avisPortalDetailsAnsehenTesten(){
  const token=portalToken_();
  const liste=portalAufruf_(token,'/api/logistics/purchase_orders?limit=20','get');
  const eintraege=Array.isArray(liste)?liste:(liste&&liste.data)||[];
  console.log('Liste hat '+eintraege.length+' Eintraege. IDs: '+eintraege.map(function(e){return e.id;}).join(', '));
  if(!eintraege.length){console.log('Keine Bestellungen gefunden -- nichts zu testen.');return;}

  const bestellungId=eintraege[0].id;
  const details=avisPortalDetailsHolen_(token,bestellungId);
  console.log('Bestellung '+bestellungId+', volle Antwort:');
  console.log(JSON.stringify(details,null,2).slice(0,3000));
  if(details.items&&details.items.length){
    console.log('Erste Position, Schluessel: '+Object.keys(details.items[0]).join(', '));
  }else{
    console.log('Kein "items"-Feld mit Inhalt gefunden -- tatsaechlichen Feldnamen aus der Ausgabe oben ablesen.');
  }
}

// Legt zwei kleine, echte Testbestellungen mit ZWEI VERSCHIEDENEN Lieferanten
// an -- genau das Szenario, das avisPortalZusammenfuehren_ spaeter zu einer
// Bestellung zusammenfuehren soll. Referenzen beginnen mit "TEST-", leicht
// wiederzufinden und zu entfernen. Loggt beide IDs fuer den naechsten Schritt.
function avisPortalZweiTestbestellungenAnlegen(){
  const morgen=new Date();morgen.setDate(morgen.getDate()+1);
  const datum=Utilities.formatDate(morgen,'Europe/Berlin',"yyyy-MM-dd'T'00:00:00.000XXX");
  const zeitstempel=Utilities.formatDate(new Date(),'Europe/Berlin','yyyyMMdd-HHmmss');

  const ersteKonfig={
    instanceKey:'1',supplierId:690381,
    supplierName:'Lieferant I; Yenibosna Merkez Mahallesi',
    anlieferdatum:datum,referenz:'TEST-ZUSAMMENFUEHREN-A-'+zeitstempel
  };
  const ersteCsv='EAN,Var-Nr.,,QUANTITY,BATCH\n4062517459920,55074-C1,"Anthrazit, S",5,\n';
  const erste=avisPortalKomplett_(ersteKonfig,ersteCsv);
  console.log('Erste Testbestellung (Lieferant I): Id '+erste.bestellungId+', Referenz '+ersteKonfig.referenz);

  const zweiteKonfig={
    instanceKey:'1',supplierId:2342679,supplierName:'Lieferant J',
    anlieferdatum:datum,referenz:'TEST-ZUSAMMENFUEHREN-B-'+zeitstempel
  };
  const zweiteCsv='EAN,Var-Nr.,,QUANTITY,BATCH\n4062517459937,55074-C2,"Anthrazit, M",3,\n';
  const zweite=avisPortalKomplett_(zweiteKonfig,zweiteCsv);
  console.log('Zweite Testbestellung (Lieferant J): Id '+zweite.bestellungId+', Referenz '+zweiteKonfig.referenz);

  console.log('Fuer den naechsten Schritt (Zusammenfuehren) werden diese beiden IDs gebraucht: '
    +erste.bestellungId+' und '+zweite.bestellungId);
}

// Fuehrt zwei bestehende Bestellungen zu einer neuen zusammen (Ansatz A):
// Positionen beider Quellen werden in einer neuen Bestellung angelegt, deren
// Referenz auf die beiden alten Nummern verweist -- danach werden die beiden
// alten Bestellungen geloescht (kein Aendern moeglich, siehe oben).
// quellIds: [id1, id2]. supplierId/supplierName: fuer die neue Bestellung, da
// eine Bestellung nur EINEN Lieferanten haben kann (Datenbank-Zwang) -- welcher
// der beiden das ist, ist eine fachliche Entscheidung, kein technischer Zwang.
// Rueckgabe: {neueBestellungId, geloeschteIds}
function avisPortalZusammenfuehren_(quellIds,supplierId,supplierName,anlieferdatum){
  const token=portalToken_();
  const quote=x=>/[",\r\n]/.test(String(x))?'"'+String(x).replace(/"/g,'""')+'"':String(x);

  const alleZeilen=[];
  quellIds.forEach(function(id){
    const bestellung=avisPortalDetailsHolen_(token,id);
    if(!bestellung.items||!bestellung.items.length){
      throw Error('Bestellung '+id+' hat keine (auslesbaren) Positionen -- Zusammenfuehren abgebrochen, nichts geaendert.');
    }
    // Tatsaechliche Form per avisPortalDetailsAnsehenTesten ermittelt (21.09.2026):
    // ean/quantity/batch liegen direkt auf der Position, Var-Nr. nur bei
    // zugeordneten Positionen im verschachtelten "sku"-Feld. Dritte Spalte
    // bleibt wie beim urspruenglichen Import leer (Header ist ebenfalls '').
    bestellung.items.forEach(function(pos){
      const varNr=pos.sku?pos.sku.variation_no:'';
      alleZeilen.push([pos.ean,varNr,'',pos.quantity,pos.batch||'',pos.note||'']);
    });
  });

  const csv=[['EAN','Var-Nr.','','QUANTITY','BATCH','NOTE'],...alleZeilen].map(r=>r.map(quote).join(',')).join('\n')+'\n';
  const referenz='Zusammengefuehrt aus Bestellung '+quellIds.join(' + ');

  const ergebnis=avisPortalKomplett_({
    instanceKey:'1',supplierId:supplierId,supplierName:supplierName,
    anlieferdatum:anlieferdatum,referenz:referenz
  },csv);

  // Erst nach erfolgreichem Anlegen der neuen Bestellung loeschen -- bei einem
  // Fehler oben bleiben die alten Bestellungen unangetastet erhalten.
  quellIds.forEach(function(id){ avisPortalBestellungLoeschen_(token,id); });

  console.log('Neue zusammengefuehrte Bestellung: Id '+ergebnis.bestellungId+', Referenz "'+referenz+'"');
  console.log('Geloescht: '+quellIds.join(', '));
  return {neueBestellungId:ergebnis.bestellungId,geloeschteIds:quellIds};
}

// Testet avisPortalZusammenfuehren_ mit den beiden per
// avisPortalZweiTestbestellungenAnlegen erzeugten Bestellungen (600, 601).
// Lieferant der neuen Bestellung: Lieferant I -- reiner Testwert, welcher der
// beiden Lieferanten in echten Faellen genommen wird, ist noch offen.
function avisPortalZusammenfuehrenEchtTesten(){
  const morgen=new Date();morgen.setDate(morgen.getDate()+1);
  const datum=Utilities.formatDate(morgen,'Europe/Berlin',"yyyy-MM-dd'T'00:00:00.000XXX");
  const ergebnis=avisPortalZusammenfuehren_([600,601],690381,
    'Lieferant I; Yenibosna Merkez Mahallesi',datum);
  console.log('Bitte im Portal pruefen: https://portal.example.com/logistics/purchase-orders/details/'+ergebnis.neueBestellungId);
}
