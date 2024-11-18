import Flatter from "./Flatter.ts";

Flatter.attach("test.sqlite")

class User extends Flatter {
    username = "";

    static SQLiteDefinition = `
        CREATE TABLE ${this.tablename} (
            uuid UUID PRIMARY KEY NOT NULL,
            created DATETIME,
            "#document" OBJECT
        );
    `;

    static {
        this.init();
    }

    constructor( anObject = {} ) {
        super(...arguments);
        Object.assign(this, anObject)
    } 

}



const u1 = new User({ username: 'james' });
u1.save();
const u2 = User.load( u1.uuid );
console.log(u1,u2)