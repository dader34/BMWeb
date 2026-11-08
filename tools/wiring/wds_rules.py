"""WDS's applicability language, as its tree names carry it.

The WDS application itself (BMW WDS v15: a frameset, a third-party tree
applet and a search script) has no applicability engine. Every rule lives in
the tree's folder and leaf NAMES as a small formal language:

    "( A or B ) with C without D as of 2001_09 up to 2003_03"

`or` is OR, `with` is AND, `without` is AND NOT, two terms side by side are
AND, `as of YYYY_MM` is production month >= and `up to YYYY_MM` is < (the
end month excluded), and `( ... )` groups. Atoms are what the dealer reads:
bodies (Saloon, Touring, Coupe, convertible, Compact), markets and steering
(USA_LHD, EUR_RHD, left-hand drive), engines ("M54 engine"), model keys
("325i_M54_SED", "M3_S54_COUPE"), ECU families ("DME Motor Electronics MS43")
and options ("Automatic transmission"). A leaf applies when its own and every
ancestor folder's conditions hold.

Parsed into {op: and|or|not, kids} / {op: atom, text} / {op: from|to, ym};
`ev` evaluates three-valued (True / False / None = undecidable), the way
tools/ista/validity_rules.py evaluates ISTA's rules, so the two can be
compared (tools/wiring/wds_vs_ista.py)."""
import re
DATE=re.compile(r'^(as of|up to)\s+(\d{4})_(\d{2})$')
def tokenize(s):
    s=s.replace('&amp;','&')
    out=[];i=0
    for m in re.finditer(r'\(|\)|\bor\b|\bwith\b|\bwithout\b|\bas of \d{4}_\d{2}\b|\bup to \d{4}_\d{2}\b|[^()]+?(?=\s*(?:\(|\)|\bor\b|\bwith\b|\bwithout\b|\bas of \d{4}_\d{2}\b|\bup to \d{4}_\d{2}\b|$))',s):
        t=m.group(0).strip()
        if t: out.append(t)
    return out
def parse(s):
    toks=tokenize(s); pos=[0]
    def peek(): return toks[pos[0]] if pos[0]<len(toks) else None
    def take(): pos[0]+=1; return toks[pos[0]-1]
    def atom():
        t=take()
        if t=='(':
            v=expr(); 
            if peek()==')': take()
            return v
        m=DATE.match(t)
        if m: return {'op':'from' if m.group(1)=='as of' else 'to','ym':int(m.group(2))*100+int(m.group(3))}
        if t=='without':
            return {'op':'not','kids':[atom()]}
        return {'op':'atom','text':t}
    def expr():
        kids=[atom()]; ops=[]
        while peek() is not None and peek()!=')':
            # a term placed next to another with no connector is an AND
            o=take() if peek() in ('or','with','without') else 'with'
            if o=='without': kids.append({'op':'not','kids':[atom()]}); ops.append('with')
            else: kids.append(atom()); ops.append(o)
        if not ops: return kids[0]
        # homogeneous sequences; mixed -> 'with' binds tighter than 'or'
        if all(o=='or' for o in ops): return {'op':'or','kids':kids}
        if all(o=='with' for o in ops): return {'op':'and','kids':kids}
        groups=[[kids[0]]]
        for o,k in zip(ops,kids[1:]):
            if o=='or': groups.append([k])
            else: groups[-1].append(k)
        return {'op':'or','kids':[g[0] if len(g)==1 else {'op':'and','kids':g} for g in groups]}
    v=expr()
    return v
def conditions_of(name):
    """every top-level (...) group in a tree name, parsed; [] when none."""
    out=[]; depth=0; start=None
    for i,c in enumerate(name):
        if c=='(':
            if depth==0: start=i
            depth+=1
        elif c==')':
            depth-=1
            if depth==0 and start is not None:
                out.append(parse(name[start+1:i])); start=None
    return out
def ev(t, atomfn, ym):
    """three-valued: True/False/None. atomfn(text)->True/False/None."""
    op=t['op']
    if op=='atom': return atomfn(t['text'])
    if op=='from': return None if ym is None else ym>=t['ym']
    if op=='to': return None if ym is None else ym<t['ym']
    if op=='not':
        v=ev(t['kids'][0],atomfn,ym); return None if v is None else (not v)
    vals=[ev(k,atomfn,ym) for k in t['kids']]
    if op=='and':
        if any(v is False for v in vals): return False
        return None if any(v is None for v in vals) else True
    if op=='or':
        if any(v is True for v in vals): return True
        return None if any(v is None for v in vals) else False
    raise ValueError(op)
if __name__=='__main__':
    for s in ['M3_S54_COUPE or M3_S54_CONV','as of 2001_03 up to 2001_09','( USA_LHD or ( 325i_M54_SED with EUR_LHD with Automatic transmission ) or 320i_M54_TOUR )',
              'as of 2001_09 without all-wheel drive without DME Motor Electronics MSS54','( Coupe or convertible ) as of 2003_03','DDE Diesel Electronics DDE3.0 without left-hand drive','up to 2005_09 or ( without USA_LHD as of 2005_09 )']:
        print(s,'\n   ->',parse(s))
