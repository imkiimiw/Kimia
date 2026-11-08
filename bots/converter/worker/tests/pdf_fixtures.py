"""Small PDFs built in code: a text layer (Helvetica), image-only scans, encrypted, rotated pages."""
import io
import zlib

import pikepdf
from PIL import Image


def text_pdf(lines=("Hello PDF 2026", "Second line"), pages=1) -> bytes:
    pdf = pikepdf.new()
    font = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))
    for n in range(pages):
        ops = "BT /F1 24 Tf 72 700 Td " + " ".join(f"({ln} {n + 1}) Tj 0 -30 Td" for ln in lines) + " ET"
        page = pdf.add_blank_page(page_size=(612, 792))
        page.obj.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
        page.obj.Contents = pdf.make_stream(ops.encode())
    buf = io.BytesIO()
    pdf.save(buf)
    return buf.getvalue()


def image_pdf(images, rotate=0) -> bytes:
    """Each PIL image becomes one page (a "scan")."""
    pdf = pikepdf.new()
    for im in images:
        rgb = im.convert("RGB")
        w, h = rgb.size
        page = pdf.add_blank_page(page_size=(w * 72 / 150, h * 72 / 150))
        xobj = pikepdf.Stream(pdf, zlib.compress(rgb.tobytes()), Type=pikepdf.Name.XObject, Subtype=pikepdf.Name.Image,
                              Width=w, Height=h, ColorSpace=pikepdf.Name.DeviceRGB, BitsPerComponent=8,
                              Filter=pikepdf.Name.FlateDecode)
        page.obj.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=xobj))
        page.obj.Contents = pdf.make_stream(f"q {w * 72 / 150:.2f} 0 0 {h * 72 / 150:.2f} 0 0 cm /Im0 Do Q".encode())
        if rotate:
            page.obj.Rotate = rotate
    buf = io.BytesIO()
    pdf.save(buf)
    return buf.getvalue()


def encrypt(data: bytes, user="secret", owner="owner-pass") -> bytes:
    with pikepdf.open(io.BytesIO(data)) as pdf:
        buf = io.BytesIO()
        pdf.save(buf, encryption=pikepdf.Encryption(user=user, owner=owner, R=6))
        return buf.getvalue()


def noisy_image(w=900, h=1200) -> Image.Image:
    return Image.effect_noise((w, h), 70).convert("RGB")
