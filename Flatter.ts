import { Database } from "jsr:@db/sqlite@0.11";
import Pluralize from "jsr:@wei/pluralize";

import julian from "npm:julian@0.2.0";
import debug from "npm:debug";

const sqllog = debug('flatter:sql');
const flog   = debug('flatter:main');

let DBConnection = new Database("flatter.sqlite");
DBConnection.run('PRAGMA journal_mode = WAL;')        
DBConnection.run('PRAGMA FOREIGN_KEY = ON;')        

type TObjectLoadCache = {
    [key: string] : string;
    toplevel : string;
}

type TDBTypeConversion = {
    toPlaceholder? : string;
    toDBValue? ( e: unknown, cache? : TObjectLoadCache) : string | string;
    toJSValue? ( e: string, cache? : TObjectLoadCache) : string | string;
}

type TDBTypeConversions = {
    [key: string] : TDBTypeConversion;
}

interface IRowInfo {
    cid : string;
    name : string;
    type : string;
    notnull : number;
    dflt_value: unknown;
    pk : number;

    fk? : object;
}

interface ITables {
    [key : string] : ITableInfo;
}

interface ITableInfo {
    [key : string] : IRowInfo;
}

interface Storable {
    uuid   : string;

    save() : boolean;
    dbValues( cache? : TObjectLoadCache ) : string[];
}

/* This defines the static interface for Flatter */
interface Loadable {
    new() : Storable;

    SQLDefinition : string;
    tableInfo : ITables;
    DBTypeConversions : TDBTypeConversions;

    get tablename() : string;
    get dbColumns() : string[];
    get dbPlaceholders() : string[];

    load( uuid : string, cache? : object) : Storable;
    init() : void;

    useDatabase( aDatabase : Database ) : void;
}

function log<This, Args extends unknown[], Return>(
    target: (this: This, ...args: Args) => Return,
    context: ClassMethodDecoratorContext<
      This,
      (this: This, ...args: Args) => Return
    >
  ) {
    const methodName = String(context.name);
  
    function replacementMethod(this: This, ...args: Args): Return {
      flog(`Entering method '${methodName}'.`);
      const result = target.call(this, ...args);
      flog(`Exiting method '${methodName}'.`);
      return result;
    }
  
    return replacementMethod;
}


function staticImplements<T>() {
    return <U extends T>(constructor: U) => { constructor };
}

@staticImplements<Loadable>()
class Flatter {
    uuid: string;

    static SQLDefinition = "";
    static DBTypeConversions : TDBTypeConversions = {};
    static tableInfo : ITables = ({} as ITables);

    private static DBTypes = {};

    get flatter () {
        return this;
    }

    static get tablename() : string {
        return Pluralize(this.name);
    }

    constructor() {
        this.uuid = crypto.randomUUID();        
    }

    static init() {
        const typename  = this.name;
        const tablename = this.tablename;

        flog(`in init() for ${typename}`)

        const tableDetails = DBConnection.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${tablename}'`).get();
        if (!tableDetails) {
            /* we need to set up the table */
            DBConnection.run( this.SQLDefinition );
        }

        const info = DBConnection.prepare(`PRAGMA table_info(${tablename})`).all();
        info.forEach( (infoRow) => {
            const castInfo : IRowInfo = (infoRow as IRowInfo);
            this.tableInfo[typename]||= {};
            this.tableInfo[typename][ castInfo.name ] = castInfo;
        })

        const fk_sql  = `PRAGMA foreign_key_list(${tablename})`;
        const fk_rows = DBConnection.prepare(fk_sql).all();
        fk_rows.forEach( (row) => {            
            this.tableInfo[typename][row.from].fk = (row as object);
        })
    }

    static useDatabase( aDatabase : Database ) : void {
        DBConnection = aDatabase;
    }

    static get dbColumns() : string[] {
        return Object.keys(this.tableInfo[this.name]);
    }

    static get dbPlaceholders() : string[] {
        const theClass = (this as Loadable);
        const typename = this.name;
        const tableInfoValues = Object.values(this.tableInfo[typename]);
        return tableInfoValues.map( (e: IRowInfo) => {
            if ( this.tableInfo[ Pluralize.singular( e.type )]) {
                // this is an object type, because it is a class/
                const placeholder = theClass.DBTypeConversions["UUID"].toPlaceholder;
                return placeholder || '?';
            } else {
                const placeholder = theClass.DBTypeConversions[ e.type ].toPlaceholder;            
                if ( typeof(placeholder) == 'string' ) {
                    return placeholder;
                } else {
                    return '?';
                }
            }
        })
    }

    @log
    dbValues( cache? : TObjectLoadCache ) : string[] {
        const theClass = (this.constructor as Loadable);
        const tableInfo = theClass.tableInfo;

        if (!cache) {
            cache = {
                toplevel: this.uuid
            };
        }

        return Object.values( tableInfo[theClass.name] ).map( ( row : IRowInfo ) : string => {            
            const value = Reflect.get(this, row.name);            
            const infoRow = theClass.DBTypeConversions[row.type];
            if (row.fk && value instanceof Flatter) {
                return (value as Storable).uuid;
            }
            const toDBValue = infoRow.toDBValue;
            if (!toDBValue) {
                return (value as string);
            }
            if (toDBValue) {
                if ( typeof(toDBValue) == 'string' ) return toDBValue;
                return toDBValue( value, cache );
            }
            return '';
        })
    }

    @log
    save( cache? : TObjectLoadCache ): boolean {
        const tablename       = (this.constructor as Loadable).tablename;
        const columns         = (this.constructor as Loadable).dbColumns;
        const dbPlaceholders  = (this.constructor as Loadable).dbPlaceholders;
        const sql = `INSERT OR REPLACE INTO ${tablename} (${columns.join(", ")}) VALUES(${dbPlaceholders.join(", ")})`

        const theUUID = this.uuid;
        this.transact( () => {
            const values = this.dbValues( cache );
            sqllog(sql,values)
            const stmt = DBConnection.prepare(sql);
            stmt.run( values );
            if ( cache ) cache[ theUUID ] = theUUID;
        }, "Flatter_save");

        return true;
    }

    @log
    public transact( aTransaction: () => void, name? : string ) {
        if ( !name ) name = "FLATNESTED"
        const begin    = `SAVEPOINT ${name}`;
        const release  = `RELEASE SAVEPOINT ${name}`;
        const rollback = `ROLLBACK TRANSACTION TO SAVEPOINT ${name}`;
        sqllog(begin)
        DBConnection.exec(begin);
        try {            
            aTransaction();
            sqllog(release)
            DBConnection.exec(release);
        } catch(e) {
            console.log(e);
            sqllog(rollback)
            DBConnection.exec(rollback);
        }        
    }

    public static load( _uuid: string, _cache? : object) : Storable {
        return new this();
    }

    static declareDBType( aType : string, aDefinition : TDBTypeConversion) : void {
        const theClass = (this as Loadable);
        theClass.DBTypeConversions[ aType ] = aDefinition;
    }
}

Flatter.declareDBType('UUID', {});
Flatter.declareDBType('TEXT', {});
Flatter.declareDBType('DATETIME', {
    toDBValue    : (e : unknown, _cache : TObjectLoadCache) : string => { return julian( e ) },
});
Flatter.declareDBType('OBJECT', {
    toPlaceholder: 'json(?)',
    toDBValue    : (e: unknown, cache : TObjectLoadCache) : string => {
        
        cache ||= { toplevel: "" };

        /* This replacer function checks to see if what we're trying to flatten is an object.
           If it is, then we check to see if its an instance of Flatter. If it is, then we need
           to be clever. If its the toplevel object, we just return it just as it is. If it isn't
           then first of all we need to replace it with a placeholder, that provides the information
           needed - essentially the class and the uuid - to retrieve the object when we
           deserialize later on. 

           We'll also need to check to see if we've encoutered this object before. If we've not, then
           we call save on it before returning the placeholder. Otherwise, we just return the placeholder.
        */
        const replacer = function(_key : string, value : unknown ) {                        
            if ( typeof(value) == 'object') {
                if ( value instanceof Flatter ) {
                    const storable = (value as Storable);
                    if ( cache.toplevel == storable.uuid ) return value;
                    const placeholder = { class: (value.constructor as ObjectConstructor).name, uuid: storable.uuid};
                    if ( !cache[ storable.uuid ] ) value.save( cache );
                    return placeholder;
                }

                else return value;
            }

            return value;
        };

        return JSON.stringify(e,replacer);            
    }
})

export default Flatter;