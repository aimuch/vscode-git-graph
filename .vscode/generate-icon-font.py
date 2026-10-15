"""
Generate resources/git-graph-icons.woff, the icon font used to display the Git Graph logo in the Status Bar
(as the product icon `$(git-graph-logo)`, contributed in package.json -> contributes.icons).

The glyph is generated from resources/cmd-icon-dark.svg. Requires fontTools (`pip install fonttools`):
    python3 .vscode/generate-icon-font.py
"""
import os
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.areaPen import AreaPen
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.recordingPen import RecordingPen
from fontTools.pens.reverseContourPen import ReverseContourPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.svgLib.path import SVGPath

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SVG_FILE = os.path.join(ROOT, 'resources', 'cmd-icon-dark.svg')
FONT_FILE = os.path.join(ROOT, 'resources', 'git-graph-icons.woff')
UNITS_PER_EM = 1000
SVG_SIZE = 16
GLYPHS = {'git-graph-logo': 0xE000}


def split_contours(recording):
	contours, current = [], []
	for operator, operands in recording.value:
		if operator in ('closePath', 'endPath'):
			# Every shape in the icon is filled, so open subpaths are closed. Empty subpaths (only a moveTo) are dropped.
			if any(op not in ('moveTo',) for op, _ in current):
				contours.append(current + [('closePath', ())])
			current = []
		else:
			current.append((operator, operands))
	return contours


def draw_glyph():
	# Scale the 16x16 SVG (y-axis pointing down) to the em square (y-axis pointing up)
	scale = UNITS_PER_EM / SVG_SIZE
	recording = RecordingPen()
	SVGPath(SVG_FILE, transform=(scale, 0, 0, -scale, 0, UNITS_PER_EM)).draw(recording)

	pen = TTGlyphPen(None)
	quadratic_pen = Cu2QuPen(pen, max_err=1.0, reverse_direction=False)
	for contour in split_contours(recording):
		contour_recording = RecordingPen()
		contour_recording.value = contour
		area_pen = AreaPen()
		contour_recording.replay(area_pen)
		# All contours are filled, so give them the same (clockwise) direction for the non-zero winding rule
		contour_recording.replay(ReverseContourPen(quadratic_pen) if area_pen.value > 0 else quadratic_pen)
	return pen.glyph()


def build_font():
	glyph_order = ['.notdef'] + list(GLYPHS)
	builder = FontBuilder(UNITS_PER_EM, isTTF=True)
	builder.setupGlyphOrder(glyph_order)
	builder.setupCharacterMap({codepoint: name for name, codepoint in GLYPHS.items()})
	builder.setupGlyf({'.notdef': TTGlyphPen(None).glyph(), 'git-graph-logo': draw_glyph()})
	builder.setupHorizontalMetrics({name: (UNITS_PER_EM, 0) for name in glyph_order})
	builder.setupHorizontalHeader(ascent=UNITS_PER_EM, descent=0)
	builder.setupNameTable({'familyName': 'Git Graph Icons', 'styleName': 'Regular'})
	builder.setupOS2(sTypoAscender=UNITS_PER_EM, sTypoDescender=0, usWinAscent=UNITS_PER_EM, usWinDescent=0)
	builder.setupPost()
	builder.font.flavor = 'woff'
	builder.save(FONT_FILE)
	print('Generated ' + os.path.relpath(FONT_FILE, ROOT))


if __name__ == '__main__':
	build_font()
