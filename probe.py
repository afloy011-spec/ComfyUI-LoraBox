import os, re, glob

base = r"C:\Users\gandzhelashvili-t\Desktop\ComfyUI\venv\Lib\site-packages\comfyui_frontend_package\static\assets"

# 1) full default computeLayoutSize return
f = os.path.join(base, "dialogService-DSBgqcNn.js")
txt = open(f, encoding="utf-8", errors="replace").read()
i = txt.find("if(this.type===`hidden`)return{minHeight:0,maxHeight:0,minWidth:0}")
print("===== default computeLayoutSize FULL =====")
print(txt[i-40:i+560])

# 2) DEFAULT_MARGIN
for m in re.finditer(r'DEFAULT_MARGIN', txt):
    s=m.start(); print("MARGIN::", txt[s-40:s+60].replace("\n"," "))

# 3) where widget width gets set (search the arrange/measure in api)
fa = os.path.join(base, "api-D9vMMk51.js")
ta = open(fa, encoding="utf-8", errors="replace").read()
print("\n===== search widget .width assignment in api =====")
for p in [r'\bwidth=[a-zA-Z_$]', r'\.width=\w', r'desiredWidth=', r'_arrangeWidgets', r'measureLayout', r'computeLayoutSize']:
    ms=list(re.finditer(p, ta))
    print("pattern", p, "count", len(ms))
    for m in ms[:4]:
        s=m.start(); print("   @",s,"::", ta[s-80:s+90].replace("\n"," "))
