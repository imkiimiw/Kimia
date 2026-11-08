import io
from pathlib import Path

import pytest
from PIL import Image, ImageCms

from app.processors import imageio as io_
from app.processors import images as ops
from app.processors.base import Input, ToolError
from tests.conftest import LIMITS, img_bytes


def inp(tmp_path, data, name="photo.png", type_="png"):
    p = tmp_path / f"in_{name}"
    p.write_bytes(data)
    return [Input(p, name, type_)]


def out_dir(tmp_path):
    d = tmp_path / "out"
    d.mkdir(exist_ok=True)
    return d


def opened(res, i=0):
    return Image.open(res.outputs[i].path)


def srgb_icc():
    return ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()


def jpeg_with_orientation(orientation, size=(40, 20)):
    im = Image.new("RGB", size, (10, 120, 200))
    ex = Image.Exif()
    ex[0x0112] = orientation
    ex[0x8825] = {2: (35.0, 41.0, 0.0)}  # a GPS block that must not survive
    buf = io.BytesIO()
    im.save(buf, format="JPEG", exif=ex.tobytes(), quality=90)
    return buf.getvalue()


@pytest.mark.parametrize("fmt", io_.write_formats())
def test_convert_to_every_writable_format(tmp_path, fmt):
    res = ops.convert(inp(tmp_path, img_bytes("PNG", (64, 48))), ops.ConvertP(format=fmt), out_dir(tmp_path), LIMITS)
    [o] = res.outputs
    assert o.name == f"photo.{io_.FORMATS[fmt][2]}" and o.type == io_.FORMATS[fmt][4]
    with Image.open(o.path) as im:
        assert im.format == io_.FORMATS[fmt][0]


def test_exif_orientation_is_applied_and_exif_dropped(tmp_path):
    res = ops.convert(inp(tmp_path, jpeg_with_orientation(6), "cam.jpg", "jpeg"), ops.ConvertP(format="png"),
                      out_dir(tmp_path), LIMITS)
    with opened(res) as im:
        assert im.size == (20, 40)
        assert not im.getexif()


def test_transparency_is_flattened_with_a_note(tmp_path):
    data = img_bytes("PNG", (20, 20), "RGBA", (255, 0, 0, 0))
    res = ops.convert(inp(tmp_path, data), ops.ConvertP(format="jpg", background="#00ff00"), out_dir(tmp_path), LIMITS)
    assert "transparency_flattened" in res.notes
    with opened(res) as im:
        r, g, b = im.convert("RGB").getpixel((10, 10))
        assert g > 200 and r < 50


def test_opaque_rgba_gets_no_flatten_note(tmp_path):
    res = ops.convert(inp(tmp_path, img_bytes("PNG", (20, 20), "RGBA", (255, 0, 0, 255))), ops.ConvertP(format="jpg"),
                      out_dir(tmp_path), LIMITS)
    assert res.notes == []


def test_animated_gif_uses_the_first_frame(tmp_path):
    frames = [Image.new("RGB", (30, 30), c) for c in ((255, 0, 0), (0, 0, 255))]
    buf = io.BytesIO()
    frames[0].save(buf, format="GIF", save_all=True, append_images=frames[1:], duration=100, loop=0)
    res = ops.convert(inp(tmp_path, buf.getvalue(), "a.gif", "gif"), ops.ConvertP(format="png"), out_dir(tmp_path), LIMITS)
    assert "animated_first_frame" in res.notes
    with opened(res) as im:
        assert im.convert("RGB").getpixel((5, 5))[0] > 200


def test_cmyk_and_16bit_are_normalized(tmp_path):
    res = ops.convert(inp(tmp_path, img_bytes("JPEG", (20, 20), "CMYK", (0, 255, 255, 0)), "c.jpg", "jpeg"),
                      ops.ConvertP(format="png"), out_dir(tmp_path), LIMITS)
    with opened(res) as im:
        assert im.mode == "RGB"
    im16 = Image.new("I;16", (20, 20), 40000)
    buf = io.BytesIO()
    im16.save(buf, format="PNG")
    res = ops.convert(inp(tmp_path, buf.getvalue(), "d.png"), ops.ConvertP(format="jpg"), out_dir(tmp_path), LIMITS)
    with opened(res) as im:
        assert im.mode == "L" and 140 <= im.getpixel((1, 1)) <= 170


def test_icc_profile_is_kept(tmp_path):
    data = img_bytes("PNG", (20, 20), icc_profile=srgb_icc())
    res = ops.convert(inp(tmp_path, data), ops.ConvertP(format="webp"), out_dir(tmp_path), LIMITS)
    with opened(res) as im:
        assert im.info.get("icc_profile")


def test_size_limits_are_checked_before_decoding(tmp_path):
    small = {**LIMITS, "max_image_pixels": 1000}
    with pytest.raises(ToolError) as e:
        ops.convert(inp(tmp_path, img_bytes("PNG", (100, 100))), ops.ConvertP(format="jpg"), out_dir(tmp_path), small)
    assert e.value.code == "IMAGE_TOO_BIG" and e.value.vars == {"mp": 0, "side": 12000}


@pytest.mark.parametrize("params,size,note", [
    ({"mode": "percent", "percent": 50}, (50, 25), None),
    ({"mode": "width", "width": 20}, (20, 10), None),
    ({"mode": "height", "height": 10}, (20, 10), None),
    ({"mode": "fit", "width": 30, "height": 30}, (30, 15), None),
    ({"mode": "exact", "width": 7, "height": 9}, (7, 9), None),
    ({"mode": "width", "width": 400}, (100, 50), "no_upscale"),
    ({"mode": "width", "width": 200, "upscale": True}, (200, 100), None),
])
def test_resize(tmp_path, params, size, note):
    res = ops.resize(inp(tmp_path, img_bytes("PNG", (100, 50))), ops.ResizeP(**params), out_dir(tmp_path), LIMITS)
    with opened(res) as im:
        assert im.size == size
    assert (note in res.notes) if note else res.notes == []
    assert res.outputs[0].name == "photo_resized.png"


def test_resize_cannot_exceed_the_limits(tmp_path):
    with pytest.raises(ToolError) as e:
        ops.resize(inp(tmp_path, img_bytes("PNG", (100, 50))), ops.ResizeP(mode="width", width=13000, upscale=True),
                   out_dir(tmp_path), LIMITS)
    assert e.value.code == "IMAGE_TOO_BIG"


@pytest.mark.parametrize("ratio,gravity,box", [
    ("1:1", "center", (25, 0, 75, 50)), ("1:1", "left", (0, 0, 50, 50)), ("16:9", "center", (6, 0, 94, 50)),
    ("9:16", "top", (36, 0, 64, 50)),
])
def test_crop_box(ratio, gravity, box):
    assert ops.crop_box(100, 50, ratio, gravity) == box


def test_rotate_and_flip(tmp_path):
    im = Image.new("RGB", (40, 20), (0, 0, 0))
    im.putpixel((0, 0), (255, 0, 0))
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    res = ops.rotate(inp(tmp_path, buf.getvalue()), ops.RotateP(angle=90), out_dir(tmp_path), LIMITS)
    with opened(res) as r:
        assert r.size == (20, 40) and r.getpixel((19, 0))[0] == 255  # clockwise: top-left → top-right
    res = ops.rotate(inp(tmp_path, buf.getvalue()), ops.RotateP(angle=30), out_dir(tmp_path), LIMITS)
    with opened(res) as r:
        assert r.width > 40
    res = ops.flip(inp(tmp_path, buf.getvalue()), ops.FlipP(axis="h"), out_dir(tmp_path), LIMITS)
    with opened(res) as r:
        assert r.getpixel((39, 0))[0] == 255


def test_compress_makes_smaller_files_or_says_it_cant(tmp_path):
    noisy = Image.effect_noise((300, 300), 60).convert("RGB")
    buf = io.BytesIO()
    noisy.save(buf, format="JPEG", quality=98)
    res = ops.compress(inp(tmp_path, buf.getvalue(), "n.jpg", "jpeg"), ops.CompressP(quality=60), out_dir(tmp_path), LIMITS)
    assert res.outputs and res.stats["after"] < res.stats["before"]
    flat = img_bytes("PNG", (64, 64), optimize=True)  # already as small as PNG gets
    res = ops.compress(inp(tmp_path, flat), ops.CompressP(quality=90), out_dir(tmp_path), LIMITS)
    assert res.outputs == [] and res.notes == ["compress_not_smaller"]


def test_strip_jpeg_is_lossless_and_keeps_orientation(tmp_path):
    data = jpeg_with_orientation(6)
    res = ops.strip(inp(tmp_path, data, "cam.jpg", "jpeg"), ops.StripP(), out_dir(tmp_path), LIMITS)
    new = Path(res.outputs[0].path).read_bytes()
    sos = data.index(b"\xff\xda")
    assert new.endswith(data[sos:])  # compressed image data untouched
    with Image.open(res.outputs[0].path) as im:
        ex = im.getexif()
        assert ex.get(0x0112) == 6 and 0x8825 not in ex
    assert res.notes == ["metadata_removed"] and res.stats["lossless"]


def test_strip_png_drops_text_chunks_keeps_icc_unless_asked(tmp_path):
    from PIL import PngImagePlugin
    meta = PngImagePlugin.PngInfo()
    meta.add_text("Author", "someone private")
    im = Image.new("RGB", (10, 10))
    buf = io.BytesIO()
    im.save(buf, format="PNG", pnginfo=meta, icc_profile=srgb_icc())
    res = ops.strip(inp(tmp_path, buf.getvalue()), ops.StripP(), out_dir(tmp_path), LIMITS)
    with opened(res) as out:
        assert "Author" not in out.info and out.info.get("icc_profile")
    res = ops.strip(inp(tmp_path, buf.getvalue()), ops.StripP(keep_icc=False), out_dir(tmp_path), LIMITS)
    with opened(res) as out:
        assert not out.info.get("icc_profile")


def test_filters_keep_size_and_alpha(tmp_path):
    data = img_bytes("PNG", (30, 20), "RGBA", (200, 100, 50, 128))
    for fn, p in ((ops.grayscale, ops.NoP()), (ops.blur, ops.BlurP()), (ops.sharpen, ops.SharpenP()),
                  (ops.color_mode, ops.ColorP(mode="sepia")), (ops.color_mode, ops.ColorP(mode="invert")),
                  (ops.color_mode, ops.ColorP(mode="bw"))):
        res = fn(inp(tmp_path, data), p, out_dir(tmp_path), LIMITS)
        with opened(res) as im:
            assert im.size == (30, 20) and im.mode == "RGBA"


def test_cmyk_output_goes_to_jpeg(tmp_path):
    res = ops.color_mode(inp(tmp_path, img_bytes("PNG", (10, 10))), ops.ColorP(mode="cmyk"), out_dir(tmp_path), LIMITS)
    with opened(res) as im:
        assert im.mode == "CMYK" and im.format == "JPEG"


def test_watermark_and_text_draw_persian(tmp_path):
    data = img_bytes("JPEG", (400, 300), color=(30, 30, 30))
    for pos in ("br", "c", "tile"):
        res = ops.watermark(inp(tmp_path, data, "p.jpg", "jpeg"), ops.WatermarkP(text="کانال واَنگر ۱۴۰۵", position=pos),
                            out_dir(tmp_path), LIMITS)
        with opened(res) as im:
            assert im.size == (400, 300) and im.convert("L").getextrema()[1] > 100  # light text was drawn
    res = ops.add_text(inp(tmp_path, data, "p.jpg", "jpeg"), ops.TextP(text="سلام 😀 دنیا", position="top"),
                       out_dir(tmp_path), LIMITS)
    assert "emoji_removed" in res.notes
    with opened(res) as im:
        top = im.crop((0, 0, 400, 60)).convert("L").getextrema()[1]
        bottom = im.crop((0, 240, 400, 300)).convert("L").getextrema()[1]
        assert top > 150 and bottom < 60


def test_text_only_emoji_is_refused(tmp_path):
    with pytest.raises(ToolError) as e:
        ops.add_text(inp(tmp_path, img_bytes("PNG")), ops.TextP(text="😀😀"), out_dir(tmp_path), LIMITS)
    assert e.value.code == "NO_TEXT"


def test_output_names_follow_the_bots_rules():
    assert io_.out_name("my.photo.JPG", "_resized", "jpg") == "my.photo_resized.jpg"
    assert io_.out_name("../../etc/passwd", "", "png") == "_.._etc_passwd.png"
    assert len(io_.out_name("a" * 200 + ".png", "_gray", "png")) == 64 + 4
    assert io_.out_name(".hidden", "", "png") == "hidden.png"


def test_only_the_declared_types_decoder_is_used(tmp_path):
    # a valid GIF declared as PNG is refused: Pillow may not pick another decoder by sniffing
    frames = io.BytesIO()
    Image.new("RGB", (10, 10)).save(frames, format="GIF")
    with pytest.raises(Exception) as e:
        ops.grayscale(inp(tmp_path, frames.getvalue(), "x.png", "png"), ops.NoP(), out_dir(tmp_path), LIMITS)
    assert "cannot identify" in str(e.value)
    xbm = b"#define x_width 8\n#define x_height 8\nstatic char x_bits[] = {0,0,0,0,0,0,0,0};\n"
    with pytest.raises(Exception):
        ops.grayscale(inp(tmp_path, xbm, "x.png", "png"), ops.NoP(), out_dir(tmp_path), LIMITS)
    with pytest.raises(ToolError) as e:
        ops.grayscale(inp(tmp_path, xbm, "x.xbm", "xbm"), ops.NoP(), out_dir(tmp_path), LIMITS)
    assert e.value.code == "IMAGE_UNSUPPORTED"
