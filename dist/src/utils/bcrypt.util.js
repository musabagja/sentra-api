import bcrypt from 'bcrypt';
class Bcrypt {
    static hash = (string) => {
        return bcrypt.hashSync(string, process.env.BCRYPT_SALT_ROUND);
    };
    static compare = (string, hash) => {
        return bcrypt.compareSync(string, hash);
    };
}
export default Bcrypt;
