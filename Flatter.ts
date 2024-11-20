import { Database } from "jsr:@db/sqlite@0.11";
import julian from "npm:julian@0.2.0";
import { plural } from "https://deno.land/x/deno_plural@2.0.0/mod.ts";

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
        return plural(this.name);
    }

    constructor( aTemplate? : object ) {
        this.uuid = crypto.randomUUID();
        Object.assign(this, aTemplate);
    }

    static init() {
        const typename  = this.name;
        const tablename = this.tablename;

        const tableDetails = DBConnection.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${tablename}'`).get();
        if (!tableDetails) {
            /* we need to set up the table */
            DBConnection.run( this.SQLDefinition );
        }

        const info = DBConnection.prepare(`PRAGMA table_info(${tablename})`).all();
        info.forEach( (infoRow) => {
            const castInfo : IRowInfo = (infoRow as IRowInfo);
            const DBType = castInfo.type;
            if (!this.DBTypeConversions[ DBType ]) throw new Error(`type ${DBType} used in database is not defined in software`);
            this.tableInfo[typename]||= {};
            this.tableInfo[typename][ castInfo.name ] = castInfo;
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
            const placeholder = theClass.DBTypeConversions[ e.type ].toPlaceholder;            
            if ( typeof(placeholder) == 'string' ) {
                return placeholder;
            }
            return '?';
        })
    }

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
            const toDBValue = theClass.DBTypeConversions[row.type].toDBValue;
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

    save( cache? : TObjectLoadCache ): boolean {
        const tablename       = (this.constructor as Loadable).tablename;
        const columns         = (this.constructor as Loadable).dbColumns;
        const dbPlaceholders  = (this.constructor as Loadable).dbPlaceholders;
        const sql = `INSERT OR REPLACE INTO ${tablename} (${columns.join(", ")}) VALUES(${dbPlaceholders.join(", ")})`
        console.log(sql);
        const values = this.dbValues( cache );
        console.log(values);
        if ( cache ) cache[ this.uuid ] = this.uuid;
        return true;
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