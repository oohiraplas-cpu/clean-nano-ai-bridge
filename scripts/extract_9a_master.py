#!/usr/bin/env python3
"""Read only: convert verified 9A worksheet columns into JSON master rows. No workbook edits."""
import argparse, json, re, zipfile, xml.etree.ElementTree as ET
M='{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
R='{http://schemas.openxmlformats.org/officeDocument/2006/relationships}'

def load_master(path):
    with zipfile.ZipFile(path) as z:
        workbook=ET.fromstring(z.read('xl/workbook.xml'))
        rels=ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
        paths={x.attrib['Id']:x.attrib['Target'] for x in rels}
        sheets=workbook.find(M+'sheets')
        sheet=next((s for s in sheets if s.attrib.get('name')=='9A'),None)
        if sheet is None: raise ValueError('9Aシートがありません')
        target=paths[sheet.attrib[R+'id']].lstrip('/')
        if not target.startswith('xl/'): target='xl/'+target
        shared=[]
        if 'xl/sharedStrings.xml' in z.namelist():
            shared=[''.join(x.itertext()) for x in ET.fromstring(z.read('xl/sharedStrings.xml')).findall(M+'si')]
        root=ET.fromstring(z.read(target)); result=[]; seen=set()
        for row in root.findall('.//'+M+'sheetData/'+M+'row'):
            if int(row.attrib['r'])<4: continue
            fields={}
            for cell in row.findall(M+'c'):
                key=re.match('[A-Z]+',cell.attrib['r']).group();v=cell.find(M+'v')
                if v is None: continue
                value=shared[int(v.text)] if cell.attrib.get('t')=='s' else v.text
                fields[key]=str(value or '').strip()
            if fields.get('A','').strip()!='9A': continue
            required=['B','C','D','E','F','G','H']
            if any(not fields.get(k) for k in required):raise ValueError('必須項目が欠損: Excel行 '+row.attrib['r'])
            if not re.fullmatch(r'\\d{2}',fields['F']) or not re.fullmatch(r'\\d{6}',fields['G']) or not re.fullmatch(r'\\d{2}',fields['H']):raise ValueError('顧客番号形式が不正: '+row.attrib['r'])
            customer='-'.join(fields[k] for k in ['F','G','H'])
            if customer in seen:raise ValueError('顧客番号重複: '+customer)
            seen.add(customer)
            result.append({'customerNumber':customer,'receptionNumber':fields['B'],'address':fields['C']+fields['D']+fields['E'],'area':fields['C']+fields['D'],'block':fields['E'],'customerName':fields.get('I',''),'meterNumber':fields.get('O',''),'position':fields.get('V',''),'excelRow':int(row.attrib['r'])})
        if not result:raise ValueError('9Aデータがありません')
        return result
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('xlsx');p.add_argument('--output');a=p.parse_args();data=load_master(a.xlsx)
    payload=json.dumps(data,ensure_ascii=False,indent=2)
    if a.output:
        with open(a.output,'x',encoding='utf8') as f:f.write(payload)
    else:print(payload)
