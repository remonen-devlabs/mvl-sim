import Toybox.Activity;
import Toybox.Application;
import Toybox.Graphics;
import Toybox.Lang;
import Toybox.Math;
import Toybox.WatchUi;

// 3 s power in big digits, coloured by power zone (Coggan, % of FTP), over a bar graph of the
// last 60 seconds of power.
class PowerZoneView extends WatchUi.DataField {

    private const HISTORY = 60;
    // Zone upper limits in % of FTP: Z1 .. Z5; above the last is Z6
    private const LIMITS = [55, 75, 90, 105, 120] as Array<Number>;
    private const COLORS = [0x9A9A9A, 0x3C8CFF, 0x3CC85A, 0xFFC81E, 0xFF8C1E, 0xFF3C28] as Array<Number>;

    private var _ftp as Number = 250;
    private var _history as Array<Number?> = new Array<Number?>[HISTORY];
    private var _next as Number = 0;
    private var _power as Number? = null;

    function initialize() {
        DataField.initialize();
        loadSettings();
    }

    function loadSettings() as Void {
        var ftp = Application.Properties.getValue("ftp");
        _ftp = (ftp instanceof Number && ftp > 0) ? ftp : 250;
    }

    function compute(info as Activity.Info) as Void {
        _history[_next] = info.currentPower;
        _next = (_next + 1) % HISTORY;
        // 3 s power: the average of the last three samples that have power
        var sum = 0;
        var n = 0;
        for (var i = 1; i <= 3; i++) {
            var p = _history[(_next - i + HISTORY) % HISTORY];
            if (p != null) {
                sum += p;
                n++;
            }
        }
        _power = n > 0 ? Math.round(sum.toFloat() / n).toNumber() : null;
    }

    function onUpdate(dc as Dc) as Void {
        var w = dc.getWidth();
        var h = dc.getHeight();
        var bg = getBackgroundColor();
        var fg = bg == Graphics.COLOR_BLACK ? Graphics.COLOR_WHITE : Graphics.COLOR_BLACK;
        dc.setColor(fg, bg);
        dc.clear();

        // Bar graph in the lower part, scaled to 150 % of FTP
        var graphH = h * 2 / 5;
        var barW = w.toFloat() / HISTORY;
        for (var i = 0; i < HISTORY; i++) {
            var p = _history[(_next + i) % HISTORY];
            if (p == null || p <= 0) {
                continue;
            }
            var bh = p * graphH / (_ftp * 3 / 2);
            if (bh > graphH) {
                bh = graphH;
            }
            dc.setColor(COLORS[zone(p) - 1], Graphics.COLOR_TRANSPARENT);
            var x = (i * barW).toNumber();
            dc.fillRectangle(x, h - bh, ((i + 1) * barW).toNumber() - x, bh);
        }

        var power = _power;
        var z = power != null ? zone(power) : 0;
        dc.setColor(fg, Graphics.COLOR_TRANSPARENT);
        dc.drawText(w / 2, 2, Graphics.FONT_XTINY, z > 0 ? "3s POWER  Z" + z : "3s POWER", Graphics.TEXT_JUSTIFY_CENTER);
        if (z > 0) {
            dc.setColor(COLORS[z - 1], Graphics.COLOR_TRANSPARENT);
        }
        var text = power != null ? power.format("%d") : "--";
        var top = dc.getFontHeight(Graphics.FONT_XTINY);
        var font = fitFont(dc, text, w - 8, h - graphH - top);
        dc.drawText(w / 2, top + (h - graphH - top) / 2, font, text,
            Graphics.TEXT_JUSTIFY_CENTER | Graphics.TEXT_JUSTIFY_VCENTER);
    }

    // Zone 1..6 of a power in watts
    private function zone(p as Number) as Number {
        var pct = p * 100 / _ftp;
        for (var i = 0; i < LIMITS.size(); i++) {
            if (pct < LIMITS[i]) {
                return i + 1;
            }
        }
        return LIMITS.size() + 1;
    }

    private function fitFont(dc as Dc, text as String, w as Number, h as Number) as Graphics.FontType {
        var fonts = [Graphics.FONT_NUMBER_THAI_HOT, Graphics.FONT_NUMBER_HOT, Graphics.FONT_NUMBER_MEDIUM,
            Graphics.FONT_NUMBER_MILD, Graphics.FONT_MEDIUM] as Array<Graphics.FontType>;
        for (var i = 0; i < fonts.size(); i++) {
            if (dc.getFontHeight(fonts[i]) <= h && dc.getTextWidthInPixels(text, fonts[i]) <= w) {
                return fonts[i];
            }
        }
        return Graphics.FONT_SMALL;
    }

}
