import { ServiceProvider } from '@nucleic-se/gears';
import { Room } from './Room.js';
import { RoomLog } from './RoomLog.js';

declare module '@nucleic-se/gears' {
    interface ServiceMap {
        'ivy.RoomLog': RoomLog;
        'ivy.Room': Room;
    }
}

export class IvyServiceProvider extends ServiceProvider {
    register(): void {
        this.app.singleton('ivy.RoomLog', () => {
            const shared = this.app.make('SharedDatabase');
            return new RoomLog(shared.db);
        });

        this.app.singleton('ivy.Room', () => {
            const log = this.app.make('ivy.RoomLog');
            const logger = this.app.make('ILogger');
            return new Room(log, logger);
        });
    }
}
