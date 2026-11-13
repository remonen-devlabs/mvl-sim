import Toybox.Application;
import Toybox.Lang;
import Toybox.WatchUi;

// MVL Sim example: a data field to try MVL Sim with (see "Sample ride" in the MVL Sim README).
class PowerZoneApp extends Application.AppBase {

    private var _view as PowerZoneView?;

    function initialize() {
        AppBase.initialize();
    }

    function getInitialView() as [Views] or [Views, InputDelegates] {
        var view = new PowerZoneView();
        _view = view;
        return [ view ];
    }

    function onSettingsChanged() as Void {
        var view = _view;
        if (view != null) {
            view.loadSettings();
        }
        WatchUi.requestUpdate();
    }

}
