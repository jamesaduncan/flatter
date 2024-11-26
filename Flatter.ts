import { Database } from "jsr:@db/sqlite@0.11";
import Pluralize from "jsr:@wei/pluralize";
import julian from "npm:julian@0.2.0";
import debug from "npm:debug";
import criterion from "npm:criterion";

const sqllog = debug('flatter:sql');
const flog   = debug('flatter:main');

let DBConnection : Database;

type TObjectLoadCache = {
    [key: string] : Storable;
    toplevel : Storable;
}

type TDBTypeConversion = {
    toPlaceholder? : string;
    toDBValue? ( e: unknown, cache? : TObjectLoadCache) : string | string;
    toJSValue? ( e: string, cache? : TObjectLoadCache) : unknown;
}

type TDBTypeConversions = {
    [key: string] : TDBTypeConversion;
}

type TRowInfo = {
    cid : string;
    name : string;
    type : string;
    notnull : number;
    dflt_value: unknown;
    pk : number;

    fk? : object;
}

type TTables = {
    [key : string] : TTableInfo;
}

type TTableInfo = {
    [key : string] : TRowInfo;
}

interface Storable {
    uuid   : string;

    save() : boolean;
    dbValues( cache? : TObjectLoadCache ) : string[];
}

type TTypeCache = {
    [key : string] : Loadable;
}

/* This is the static interface for Flatter */
interface Loadable {
    new() : Storable;

    SQLDefinition : string;
    tableInfo : TTables;
    DBTypeConversions : TDBTypeConversions;
    TypeCache : TTypeCache;

    get tablename() : string;
    get dbColumns() : string[];
    get dbPlaceholders() : string[];

    load( criteria : object, cache? : object) : Storable[];
    loadWithUUID( aUUID : string, cache? : object) : Storable;

    init() : void;

    useDatabase( aDatabase : string ) : void;
    useDatabase( aDatabase : Database ) : void;
}

type TProxy = {
    class : string;
    uuid  : string;
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
      flog(`Entering '${methodName}(${Deno.inspect(args)})'.`);
      const result = target.call(this, ...args);
      flog(`Exiting '${methodName}'.`);
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
    static tableInfo : TTables = ({} as TTables);
    static TypeCache : TTypeCache = {};

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

        if (!DBConnection) {
            Flatter.useDatabase("flatter.sqlite");
        }

        const typename  = this.name;
        const tablename = this.tablename;

        this.TypeCache[typename] = this;

        flog(`in init() for ${typename}`)

        const tableDetails = DBConnection.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${tablename}'`).get();
        if (!tableDetails) {
            /* we need to set up the table */
            DBConnection.run( this.SQLDefinition );
        }

        const info = DBConnection.prepare(`PRAGMA table_info(${tablename})`).all();
        info.forEach( (infoRow) => {
            const castInfo : TRowInfo = (infoRow as TRowInfo);
            this.tableInfo[typename]||= {};
            this.tableInfo[typename][ castInfo.name ] = castInfo;
        })

        const fk_sql  = `PRAGMA foreign_key_list(${tablename})`;
        const fk_rows = DBConnection.prepare(fk_sql).all();
        fk_rows.forEach( (row) => {            
            this.tableInfo[typename][row.from].fk = (row as object);
        })
    }

    static useDatabase( aDatabase : Database | string) : void {
        if ( aDatabase instanceof Database ) {
            DBConnection = aDatabase;
        } else {
            DBConnection = new Database("flatter.sqlite");
        }
        DBConnection.run('PRAGMA journal_mode = WAL;')        
        DBConnection.run('PRAGMA FOREIGN_KEY = ON;')                    
    }

    static get dbColumns() : string[] {
        return Object.keys(this.tableInfo[this.name]);
    }

    static get dbPlaceholders() : string[] {
        const theClass = (this as Loadable);
        const typename = this.name;
        const tableInfoValues = Object.values(this.tableInfo[typename]);
        return tableInfoValues.map( (e: TRowInfo) => {
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
    dbValues( cache : TObjectLoadCache ) : string[] {
        const theClass = (this.constructor as Loadable);
        const tableInfo = theClass.tableInfo;

        return Object.values( tableInfo[theClass.name] ).map( ( row : TRowInfo ) : string => {            
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
                const val = toDBValue( value, cache );
                return val;
            }
            return '';
        })
    }

    @log
    save( cache? : TObjectLoadCache ): boolean {
        flog(`{ uuid: '${this.uuid}' }).save()`)


        const tablename       = (this.constructor as Loadable).tablename;
        const columns         = (this.constructor as Loadable).dbColumns;
        const dbPlaceholders  = (this.constructor as Loadable).dbPlaceholders;
        const sql = `INSERT OR REPLACE INTO ${tablename} (${columns.join(", ")}) VALUES(${dbPlaceholders.join(", ")})`

        if (!cache) {
            cache = { toplevel: this };
            cache[ this.uuid ] = ({ uuid: this.uuid } as Storable);
        } else {
            // we've already done this.
            if (this.uuid == (cache.toplevel as Storable).uuid ) return true;
            if (cache[this.uuid]) return true;
        }

        const theUUID = this.uuid;

        this.transact( () => {
            const values = this.dbValues( cache );            
            sqllog(sql,values)
            const stmt = DBConnection.prepare(sql);
            stmt.run( values );
            cache[ theUUID ] = this;
        }, "Flatter_save");        

        cache[ this.uuid ] = ({ uuid: this.uuid } as Storable);

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

    @log
    public static loadWithUUID( aUUID : string, cache? : object) : Storable {        
        if (!cache) cache = { toplevel: aUUID }
        if (cache[ aUUID as keyof object]) return cache[ aUUID as keyof object ];

        const sql = `SELECT * FROM ${this.tablename} WHERE uuid = ?`;
        let row = DBConnection.prepare(sql).get(aUUID);
        if (!row) throw new Error(`no object with uuid ${aUUID} found`);

        type FlatterObject = {
            flatter : string;
            [key : string] : unknown;
        }

        if ( row.flatter ) {
            row = JSON.parse( (row as FlatterObject).flatter, (_key : string, value : unknown, _context? : string) => {
                if ( value instanceof Object) {
                    const theValue = (value as TProxy);
                    const aClass = this.TypeCache[ theValue.class ];
                    if (!aClass) return value;
                    const uuid   = theValue.uuid;
                    if (uuid == aUUID) return value;
                    const cachekey = (theValue.uuid as keyof object);
                    if ( !( cache[cachekey] )) {
                        const toCache = aClass.loadWithUUID( theValue.uuid, cache );
                        /* I'm using reflect here because of a weird type error in typescript.
                           I know its a bit of a hack, but it saves some shenanigans elsewhere. */
                        Reflect.set(cache, cachekey, (toCache as Storable));
                    }
                    return cache[cachekey];
                }
                return value;
            });
        }

        const entries = Object.entries( (row as object) );    
        const objectProperties = Object.fromEntries( entries.map( ([k,v]) => {            
            // here we need to check the data that we got out of the DB early on, and look
            // for an appropriate type conversion (toJSValue). If it exists, we need to run
            // it to get the value. If not, we can just use v, as it already does.
            const tableInfo = this.tableInfo[this.name];
            const rowType = tableInfo[k].type;
            const typeConversion = this.DBTypeConversions[ rowType ];
            if (typeConversion && typeConversion.toJSValue) {
                return [ k, {
                    writable: true,
                    enumerable: true,
                    configurable: true,
                    value: typeConversion.toJSValue( v )
                }];
            } else {
                return [ k, {
                    writable: true,
                    enumerable: true,
                    configurable: true,
                    value: v
                }];
            }
        }) );
        Reflect.set( cache, aUUID, Object.create(new this(), objectProperties))
        return cache[ aUUID as keyof object];
    }

    @log
    public static load( criteria : object, _cache? : object) : Storable[] {        
        const query = `SELECT uuid FROM ${this.tablename}`;
        const where = criterion( criteria );
        const sql = [query, `WHERE ${where.sql()}`].join(" ");
        return DBConnection.prepare(sql).all( where.params() ).map( (row : object) => {
            return this.loadWithUUID( (row as Storable).uuid );
        })
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
// @ts-ignore: this is very definitely what I want to do, but it won't match a generic signature.
    toJSValue    : (e) => { return new Date(e) ; }
});
Flatter.declareDBType('OBJECT', {
    toPlaceholder: 'json(?)',
    toDBValue    : (e: unknown, cache : TObjectLoadCache) : string => {

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
            if ( value instanceof Flatter && (e as Storable).uuid == value.uuid ) {
                return value;
            } else if (value instanceof Flatter) {
                const proxy = { 
                    class: (value.constructor as ObjectConstructor).name,
                    uuid : (value as Storable).uuid
                };
                value.save( cache )
                return proxy;
            } else {
                return value;
            }
        };

        return JSON.stringify(e,replacer);            
    }
})

export default Flatter;