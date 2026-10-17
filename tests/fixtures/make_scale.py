# Original test-score generator, 2026-10-17. AGPL-3.0.
# Requires reportlab and the system Noto Music font (SIL Open Font License).
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from pathlib import Path
pdfmetrics.registerFont(TTFont('NotoMusic','/usr/share/fonts/truetype/noto/NotoMusic-Regular.ttf'))
p=Path(__file__).with_name('c-major-scale.pdf')
c=canvas.Canvas(str(p),pagesize=(595,842))
c.setFont('Helvetica-Bold',18);c.drawString(70,760,'Original test: C major scale')
c.setFont('Helvetica',11);c.drawString(70,737,'Two bars, eight quarter notes. Generated for conversion testing.')
y=600
c.setLineWidth(.65)
for j in range(5):c.line(65,y+j*10,550,y+j*10)
c.setFont('NotoMusic',45);c.drawString(73,y,'𝄞')
c.setFont('Times-Bold',23);c.drawString(118,y+22,'4');c.drawString(118,y+2,'4')
ys=[y-10,y-5,y,y+5,y+10,y+15,y+20,y+25]
xs=[165,215,265,315,365,415,465,515]
for x,ny in zip(xs,ys):
 if ny<y-5:c.line(x-9,ny,x+9,ny)
 c.saveState();c.translate(x,ny);c.rotate(18);c.ellipse(-6,-4,6,4,stroke=0,fill=1);c.restoreState()
 c.setLineWidth(1)
 if ny<y+20:c.line(x+5,ny,x+5,ny+33)
 else:c.line(x-5,ny,x-5,ny-33)
c.setLineWidth(.8);c.line(340,y,340,y+40);c.line(545,y,545,y+40);c.setLineWidth(2);c.line(550,y,550,y+40)
c.save()
print(p)
