from PIL import Image
src=r"C:\Users\silve\Desktop\FleetManagementProject\frontend\public\ride-logo-source.jpg"
out=r"C:\Users\silve\Desktop\FleetManagementProject\frontend\public\ride-logo.png"
img=Image.open(src).convert('RGBA')
p=img.load()
for y in range(img.height):
    for x in range(img.width):
        r,g,b,a=p[x,y]
        if r>200 and g>200 and b>200 and abs(r-g)<12 and abs(g-b)<12:
            p[x,y]=(r,g,b,0)
        else:
            p[x,y]=(r,g,b,255)
img.save(out,'PNG')
print('ok')
