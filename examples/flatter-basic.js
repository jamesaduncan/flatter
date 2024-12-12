import Flatter from "../Flatter.ts"

class User extends Flatter {
    username = "";
    profile = { bio: "Hello, world!", age: 30 };

    constructor( aTemplate ) {
        super( aTemplate );
        if (aTemplate) Object.assign(this, aTemplate); 
    }
 
    static {
        this.init();
    }
}

const user = new User({ username: "john", profile: { bio: "Hello!", age: 25 }, nicknames: [ 'jack' ] });
user.save();
console.log(user.flatter); // Outputs the `user` object itself