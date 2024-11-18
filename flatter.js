import { Database } from "jsr:@db/sqlite@0.11";
import pluralize from "npm:pluralize@8.0.0";
import julian from "npm:julian@0.2.0";
import { v4 as uuidv4, validate as uuidValidate } from 'npm:uuid@11.0.3';

let Store;

class Flatter {
    uuid = '';
    created = '';

    constructor() {
        this.created = new Date();
    }

    static attach(aFilename) {
        if (!aFilename) throw new Error("usage: ${this.name}.attach( aFilename )");
        Store = new Database(aFilename);
        Store.run('PRAGMA journal_mode = WAL;')        
        Store.run('PRAGMA FOREIGN_KEY = ON;')
    }

    static dbTypeConversions = {
        'OBJECT': {
            toPlaceholder: (_e)    => { return `json(?)` },
            toDBValue    : (e, _key) => { 
                const replacer = (_k, v) => {
                    if ( v === e ) return v; // skip the topmost object
                    if ( v instanceof Flatter ) {
                        return { Flatter: true, "class": v.constructor.name, "uuid": v.uuid }
                    }
                    if ( v instanceof Object && v.toJSON ) {
                        return v.toJSON();
                    }  
                    return v;
                };                
                return JSON.stringify( e, replacer )
            },
            toJSValue    : (e, k, cache) => { 
                const reviver = (_key, v) => {
                    if ( v instanceof Object ) {                        
                        if (v.Flatter) {       
                            return Knowr[ v.class ].load( v.uuid, cache );
                        }
                    }
                    return v;    
                };
                return JSON.parse( e[k], reviver )
            },
        },
        'DATETIME': {
            toPlaceholder: (_e)    => { return '?' },
            toDBValue    : (e, k) => { return julian(e[k]) },
            toJSValue    : (e, k, _cache = {} ) => { return julian.toDate( e[k] ); },
        }
    }

    static dbLinkConversions = {
        'UUID': (e) => {
            if ( e instanceof Flatter ) {
                return e.uuid;
            }
        }
    }

    static init() {
        const table_name = pluralize.plural( this.name ).toLowerCase();
        
        const tinfo_sql = `PRAGMA table_info(${table_name})`;
        let tinfo_rows = this.db.prepare(tinfo_sql).all();

        if (!tinfo_rows.length) {
            if (this.SQLiteDefinition) {
                this.db.exec(this.SQLiteDefinition)
                tinfo_rows = this.db.prepare(tinfo_sql).all();
            }
        }

        const tableInfo = {};
        tinfo_rows.forEach( (row) => {
            tableInfo[ row.name ] = row;
            
            // we set this here so that all rows do not have foreign key info by default.
            tableInfo[ row.name ].fkInfo = false;
        })
        this.tableInfo = tableInfo;

        const fk_sql  = `PRAGMA foreign_key_list(${table_name})`;
        const fk_rows = this.db.prepare(fk_sql).all();

        fk_rows.forEach( (row) => {
            this.tableInfo[ row.from ].fkInfo = row;
        })
    }

    static get db() {
        return Store;
    }

    get db() {
        return Store;
    }

    get #tablename() {
        return pluralize( this.constructor.name.toLowerCase() );
    }

    static get tablename() {
        return pluralize( this.name.toLowerCase() );
    }

    static get db_columns() {
        return Object.keys( this.tableInfo );
    }

    static get db_placeholders() {
        return Object.entries( this.tableInfo ).map( ([_k, v]) => {
            if ( this.dbTypeConversions[ v.type ] ) return this.dbTypeConversions[ v.type ].toPlaceholder();
            return '?';
        })
    }

    get #dbvalues() {
        return Object.entries( this.constructor.tableInfo ).map( ([k, v]) => {        
            //console.log(`preparing value in property ${k} with the db type ${v.type}`)
            /* this looks for type conversions from one value to another */
            if ( this.constructor.dbTypeConversions[ v.type ] ) return this.constructor.dbTypeConversions[ v.type ].toDBValue( this, k );
            /* this looks for foreign key links */
            if ( v.fkInfo ) return this.constructor.dbLinkConversions[ v.type ]( this[k] );
            return this[ k ];
        });
    }

    static sqlCriteria( anObject = {} ) {
        return Object.entries( anObject ).map( ([key, val]) => {
          let operator, value;
          if ( val instanceof Object ) {
            operator = Object.keys(val)[0];
            value    = Object.values(val)[0];
          } else {
            operator = '=';
            value    = val;
          }
          return [key, operator, value];
        });
    }
    
    static loadWithCriteria( anObject = {}, conditions = {} ) {
        const crits = this.sqlCriteria( anObject );
        const critQ = crits.map( (e) => `${e[0]} ${e[1]} ?` ).join(' AND ');

        let sql = `SELECT uuid FROM ${this.tablename}`;
        
        if (critQ) sql += ` WHERE ${critQ}`;

        if ( conditions.order ) {
            sql += ` ORDER BY ${conditions.order}`;
            if ( conditions.ascending ) {
            sql += ``; /* ascending happens by default */
            } else if ( conditions.descending ) {
            sql += ` DESC`
            }
        }

        if ( conditions.limit ) {
            sql += ` LIMIT ${conditions.limit}`;
        }

        const args = crits.map((e)=>e[2]);
        
        const stmt = this.db.prepare(sql);    
        let rows = stmt.all(...args);
        rows = rows.map( (row) => {            
            return this.load(row.uuid)
        });
        return rows;
    }

    static load( uuid, cache ) {
        if (!uuidValidate( uuid )) {
            return this.loadWithCriteria( uuid, { limit: 1 })[0];
        }

        if (!cache) {
            //console.log(`starting new cache for load of ${this.name}:${uuid}`)
            cache = {};
        } else {
            //console.log(`using existing cache for load of ${this.name}:${uuid}`)
        }
        if ( cache[uuid] ) {
            //console.log(`cache hit for load of ${this.name}:${uuid}`);
            return cache[uuid];
        }
        
        const cols = this.db_columns.map(e => `"${e}"`);
        const sql = `SELECT ${cols.join(", ")} FROM ${this.tablename} WHERE uuid = ?`;
        const stmt = this.db.prepare( sql );
        const row = stmt.get( uuid );

        /*
            This is the code that essentially hydrates the object from the database, getting it
            back to the state that we had it in when we shoved it in.
        */
        cache[ row.uuid ] = row;
        // if we have an object field, then we replace EVERYTHING we got from the DB with that object.
        //   make sure we pass the cache in to the reviver, so any loads that it does are property
        //   pulled out of the cache first, thus avoiding circuallar refs; hopefully :-/
        const objectField = Object.values( this.tableInfo ).filter( e => e.type == 'OBJECT' )[0];
        const hydratedObject = this.dbTypeConversions.OBJECT.toJSValue( row, objectField.name, cache);

        // now we go through the tableInfo, where there are db value conversions, we need to execute them
        //   against the original row data, and put the outcome of that into the hydrated object. The only
        //   place where this isn't true is the OBJECT type, which we ignore, as we've already dealt with that
        Object.values( this.tableInfo ).filter( e => e.type != 'OBJECT').forEach( (e) => {
            const tinfo = this.dbTypeConversions[ e.type ];
            // not everything will have a type conversion. Most things will not.
            if (tinfo) hydratedObject[ e.name ] = tinfo.toJSValue( row, e.name, cache );
        })
        
        const finalObject = new this( hydratedObject );
        
        // replace the temporary cache with the final one
        cache[ finalObject.uuid ] = finalObject;
        
        return finalObject;
    }

    save() {
        if (!this.uuid) this.uuid = uuidv4();
        const cols = this.constructor.db_columns.map( e => `"${e}"`);
        const sql  = `INSERT OR REPLACE INTO ${this.#tablename} (${cols.join(', ')}) VALUES(${ this.constructor.db_placeholders.join(', ')})`;
        const stmt = this.db.prepare( sql );
        const vals = this.#dbvalues;
        const rows = stmt.run( vals );
        return !!rows.changes;
    }

}

export default Flatter;
